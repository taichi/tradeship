"use strict";

const path = require("path");

const { fileRegex, findPkgMeta, whiteRegex } = require("./common");
const DepRegistry = require("./dep-registry");
const findImports = require("../visits/find-imports.js");
const findStyle = require("../visits/find-style.js");
const resolveJSX = require("../visits/resolve-jsx.js");
const walker = require("./walker.js");

const backslashRegex = /\\/g;

exports.run = function(dir, code, override) {
  return findPkgMeta(dir).then(meta => {
    if (override) {
      meta = Object.assign({}, meta, override);
    }

    const context = walker.run(meta, code, [
      findImports,
      findStyle,
      resolveJSX
    ]);

    if (context.error) {
      throw context.error;
    }

    // resolve all relative dependency paths
    context.reqs.forEach(req => {
      if (fileRegex.test(req.depID)) {
        // must split on forward slash so resolving works correctly on Windows
        req.depID = path.resolve(dir, ...req.depID.split("/"));
      }
    });

    return DepRegistry.populate(dir, meta)
      .then(depRegistry => rewriteCode(context, depRegistry, dir));
  });
};

function rewriteCode(context, depRegistry, dir) {
  const { linesToRemove, libsToAdd } = resolveIdents(context, depRegistry);
  let requiresText = composeRequires(context.style, dir, libsToAdd);

  let newCode = "";
  let targetLine = null;

  if (context.reqs.length > 0) {
    targetLine = context.reqs[0].node.loc.start.line;
  } else if (requiresText.length > 0) {
    const directive = context.getUseStrict();

    if (directive) {
      if (context.endsLine(directive)) {
        requiresText = "\n" + requiresText + "\n";
        targetLine = directive.loc.end.line;
      } else {
        const { loc: { end } } = directive;
        const endLineText = context.getLineText(end.line);

        // use strict is on the same line as some other text. Unfortunately,
        // with the current architecture, it's not easy to add the requires
        // between use strict and the other text, as we operate on a
        // line-by-line basis. Consequently, we resort to directly modifying
        // the line. This is ugly, but it's not worth changing the architecture
        // for a quite rare edge case like this one. Note that we can't add
        // a line to textLines because that would change line numbers and
        // break our logic below.
        context.textLines[end.line - 1] = endLineText.slice(0, end.column) +
          "\n\n" +
          requiresText +
          "\n\n" +
          endLineText.slice(end.column + 1);
      }
    } else {
      requiresText = requiresText + "\n";
      targetLine = 0;
    }
  }

  // start at non-existent line 0 to allow requiresText to be prepended
  linesToRemove.add(0);
  for (let line = 0; line <= context.textLines.length; line++) {
    if (!linesToRemove.has(line)) {
      newCode += context.getLineText(line) + "\n";
    }
    if (line === targetLine && requiresText.length > 0) {
      newCode += requiresText + "\n";
    }
  }

  if (newCode.slice(-1) !== "\n") {
    newCode = newCode + "\n";
  } else if (newCode.slice(-2) === "\n\n") {
    newCode = newCode.slice(0, -1);
  }
  return newCode;
}

function resolveIdents(context, depRegistry) {
  const missingIdents = findMissingIdents(context);
  const fixableIdents = missingIdents.filter(i => depRegistry.search(i));

  const deps = fixableIdents.map(i => depRegistry.search(i));
  const depIDs = context.reqs.map(req => req.depID).concat(deps.map(d => d.id));

  const libsToAdd = {};
  depIDs.forEach(
    id => libsToAdd[id] = {
      idents: [],
      defaults: [],
      props: []
    }
  );

  const { types } = DepRegistry;
  fixableIdents.forEach((ident, i) => {
    const { id, type } = deps[i];
    const lib = libsToAdd[id];

    switch (type) {
      case types.ident:
        lib.idents.push(ident);
        break;
      case types.default:
        lib.defaults.push(ident);
        break;
      case types.prop:
        lib.props.push(ident);
        break;
      default:
        throw new Error("unexpected type " + type);
    }
  });

  const nodesToRemove = [];
  context.reqs.forEach(({ node, depID, idents, defaults, props }) => {
    const lib = libsToAdd[depID];

    if (node) {
      nodesToRemove.push(node);
    }
    if (idents) {
      lib.idents.push(...idents);
    }
    if (defaults) {
      lib.defaults.push(...defaults);
    }
    if (props) {
      lib.props.push(...props);
    }
  });

  const linesToRemove = new Set();
  nodesToRemove.forEach(({ loc: { start, end } }) => {
    for (let line = start.line; line <= end.line; line++) {
      linesToRemove.add(line);
    }
  });

  removeExtraLines(context, libsToAdd, linesToRemove);
  return { libsToAdd, linesToRemove };
}

function findMissingIdents(context) {
  const globalScope = context.getGlobalScope();
  const missingIdents = globalScope.through
    .filter(ref => {
      // ignore:
      // - identifiers prefixed with typeof
      // - writes to undeclared variables
      const parent = ref.identifier.parent;
      const isTypeOf = parent &&
        parent.type === "UnaryExpression" &&
        parent.operator === "typeof";

      return !isTypeOf && !ref.writeExpr;
    })
    .map(ref => ref.identifier.name)
    .filter(name => !globalScope.set.get(name));
  return Array.from(new Set(missingIdents));
}

function removeExtraLines(context, libsToAdd, linesToRemove) {
  const sortedLinesToRemove = Array.from(linesToRemove)
    .sort((l1, l2) => l1 - l2);
  let prevLine = sortedLinesToRemove[0];

  // If the intermediate lines between two subsequent lines to remove are all
  // blank, remove the intermediate lines as well.
  sortedLinesToRemove.slice(1).forEach(line => {
    let allBlank = true;
    for (let j = prevLine + 1; j < line; j++) {
      allBlank = allBlank && whiteRegex.test(context.getLineText(j));
    }

    if (allBlank) {
      for (let j = prevLine + 1; j < line; j++) {
        linesToRemove.add(j);
      }
    }
    prevLine = line;
  });

  const hasNoImports = Object.keys(libsToAdd).every(id => {
    const { idents, defaults, props } = libsToAdd[id];
    return idents.length === 0 && defaults.length === 0 && props.length === 0;
  });

  // If we're removing all imports, remove the blank line after them.
  if (
    hasNoImports &&
    sortedLinesToRemove.length > 0 &&
    whiteRegex.test(context.getLineText(prevLine + 1))
  ) {
    linesToRemove.add(prevLine + 1);
  }
}

function composeRequires(style, dir, libs) {
  // turn absolute dep ids into relative ones
  Object.keys(libs).forEach(id => {
    if (path.isAbsolute(id)) {
      // node module ids always have unix-style separators
      let newID = path.relative(dir, id).replace(backslashRegex, "/");
      if (newID[0] !== ".") {
        newID = `./${newID}`;
      }
      libs[newID] = libs[id];
      delete libs[id];
    }
  });

  const ids = Object.keys(libs);
  const externalIDs = ids
    .filter(i => !fileRegex.test(i))
    .sort(compareByBasename);
  const localIDs = ids.filter(i => fileRegex.test(i)).sort(compareByBasename);

  const externalStatements = [];
  const localStatements = [];

  externalIDs.forEach(id =>
    externalStatements.push(...composeStatements(style, libs[id], id)));
  localIDs.forEach(id =>
    localStatements.push(...composeStatements(style, libs[id], id)));

  const statements = externalStatements;
  if (externalStatements.length > 0 && localStatements.length > 0) {
    // add blank line between external and local imports
    statements.push("");
  }
  statements.push(...localStatements);

  return statements.join("\n");
}

function compareByBasename(id1, id2) {
  const base1 = path.basename(id1);
  const base2 = path.basename(id2);

  if (base1 !== base2) {
    return base1 < base2 ? -1 : 1;
  }
  return id1 < id2 ? -1 : 1;
}

function composeStatements(style, lib, id) {
  const statements = [];
  const { idents, defaults, props } = lib;

  if (idents.length === 0 && defaults.length === 0 && props.length === 0) {
    // nothing to require
    return statements;
  }

  idents.sort();
  defaults.sort();
  props.sort();

  if (style.requireKeyword === "require") {
    statements.push(
      ...idents.map(ident => composeRequireStatement({ style, id, ident })),
      ...defaults.map(def => composeRequireStatement({ style, id, def }))
    );

    if (props.length > 0) {
      statements.push(composeRequireStatement({ style, id, props }));
    }
  } else {
    let leftDefaults = defaults;
    if (props && props.length > 0) {
      statements.push(
        composeImportStatement({ style, id, props, def: defaults[0] })
      );
      leftDefaults = defaults.slice(1);
    }

    statements.push(
      ...leftDefaults.map((def, i) =>
        composeImportStatement({ style, id, ident: idents[i], def })),
      ...idents
        .slice(leftDefaults.length)
        .map(ident => composeImportStatement({ style, id, ident }))
    );
  }

  return statements;
}

function composeRequireStatement({ style, id, ident, def, props, multiline }) {
  if (ident && def || ident && props || def && props) {
    throw new Error("only one of ident, default, and props must be specified");
  }

  const { kind, quote, semi } = style;
  const requireText = `require(${quote}${id}${quote})`;

  if (ident) {
    return `${kind} ${ident} = ${requireText}${semi}`;
  } else if (def) {
    return `${kind} ${def} = ${requireText}.default${semi}`;
  } else {
    const destructure = composeDestructure(style, props, multiline);
    const statement = `${kind} ${destructure} = ${requireText}${semi}`;

    if (!multiline && statement.length > 80) {
      return composeRequireStatement({
        style,
        id,
        props,
        multiline: true
      });
    }
    return statement;
  }
}

function composeImportStatement({ style, id, ident, def, props, multiline }) {
  if (ident && props && props.length > 0) {
    throw new Error("ident and props cannot both be specified");
  }

  const parts = [];
  if (def) {
    parts.push(def);
  }
  if (ident) {
    parts.push(`* as ${ident}`);
  }
  if (props && props.length > 0) {
    parts.push(composeDestructure(style, props, multiline));
  }

  const { quote, semi } = style;
  const names = parts.join(", ");
  const statement = `import ${names} from ${quote}${id}${quote}${semi}`;

  if (props && !multiline && statement.length > 80) {
    return composeImportStatement({
      style,
      id,
      ident,
      def,
      props,
      multiline: true
    });
  }
  return statement;
}

function composeDestructure(style, props, multiline) {
  if (multiline) {
    const { tab, trailingComma } = style;
    const propsText = tab + props.join(`,\n${tab}`) + trailingComma;
    return `{\n${propsText}\n}`;
  } else {
    return `{ ${props.join(", ")} }`;
  }
}
