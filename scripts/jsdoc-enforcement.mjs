// SPDX-License-Identifier: Apache-2.0

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
]);
const CLASS_TYPES = new Set(["ClassDeclaration", "ClassExpression"]);
const METHOD_TYPES = new Set(["MethodDefinition", "TSAbstractMethodDefinition"]);

function isFunction(node) {
  return node !== null && FUNCTION_TYPES.has(node.type);
}

function isClass(node) {
  return node !== null && CLASS_TYPES.has(node.type);
}

function unwrapExpression(node) {
  let current = node;
  while (
    current !== null &&
    (current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSInstantiationExpression" ||
      current.type === "TSNonNullExpression")
  ) {
    current = current.expression;
  }
  return current;
}

function identifierName(node) {
  return node !== null && typeof node?.name === "string" ? node.name : null;
}

function jsdocBefore(context, node) {
  return context.sourceCode
    .getCommentsBefore(node)
    .some((comment) => comment.type === "Block" && comment.value.trimStart().startsWith("*"));
}

function functionName(node, fallback = "<anonymous>") {
  return identifierName(node.id) ?? fallback;
}

function propertyName(node) {
  const key = node.key;
  return identifierName(key) ?? (typeof key?.value === "string" ? key.value : "<computed>");
}

function bindingName(node) {
  return identifierName(node);
}

function methodIsPublic(node) {
  return (
    METHOD_TYPES.has(node.type) &&
    node.kind !== "constructor" &&
    node.accessibility !== "private" &&
    node.accessibility !== "protected" &&
    node.key.type !== "PrivateIdentifier"
  );
}

function addDeclarationBindings(bindings, declaration) {
  if (declaration === null) return;
  if (isFunction(declaration) || isClass(declaration)) {
    const name = bindingName(declaration.id);
    if (name !== null) {
      bindings.set(name, {
        kind: isClass(declaration) ? "class" : "function",
        docsNode: declaration,
        target: declaration,
        classNode: isClass(declaration) ? declaration : null,
      });
    }
    return;
  }
  if (declaration.type !== "VariableDeclaration") return;
  for (const declarator of declaration.declarations) {
    const name = bindingName(declarator.id);
    if (name === null) continue;
    const initializer = unwrapExpression(declarator.init);
    if (isFunction(initializer)) {
      bindings.set(name, {
        kind: "function",
        docsNode: declaration,
        target: declarator,
        classNode: null,
      });
    } else if (isClass(initializer)) {
      bindings.set(name, {
        kind: "class",
        docsNode: declaration,
        target: declarator,
        classNode: initializer,
      });
    }
  }
}

function buildBindings(program) {
  const bindings = new Map();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    addDeclarationBindings(bindings, declaration);
  }
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      const name = bindingName(declarator.id);
      const initializer = unwrapExpression(declarator.init);
      const targetName = identifierName(initializer);
      const target = targetName === null ? undefined : bindings.get(targetName);
      if (name === null || target === undefined) continue;
      bindings.set(name, {
        kind: target.kind,
        docsNode: declaration,
        target: declarator,
        classNode: target.classNode,
      });
    }
  }
  return bindings;
}

function createRule(context) {
  const checkedFunctions = new WeakSet();
  const checkedClasses = new WeakSet();
  const checkedMethods = new WeakSet();
  let bindings = new Map();

  function checkFunction(target, docsNode, name) {
    if (checkedFunctions.has(target)) return;
    checkedFunctions.add(target);
    if (!jsdocBefore(context, docsNode)) {
      context.report({
        node: docsNode,
        message: `Exported function "${name}" must have a JSDoc comment.`,
      });
    }
  }

  function checkClass(
    classNode,
    docsNode = classNode,
    name = classNode === null ? null : identifierName(classNode.id),
  ) {
    if (classNode === null || checkedClasses.has(classNode)) return;
    checkedClasses.add(classNode);
    if (!jsdocBefore(context, docsNode)) {
      context.report({
        node: docsNode,
        message: `Exported class "${name ?? "<anonymous>"}" must have a JSDoc comment.`,
      });
    }
    for (const member of classNode.body.body) {
      if (!methodIsPublic(member) || checkedMethods.has(member)) continue;
      checkedMethods.add(member);
      if (!jsdocBefore(context, member)) {
        context.report({
          node: member,
          message: `Public method "${propertyName(member)}" must have a JSDoc comment.`,
        });
      }
    }
  }

  function checkVariableDeclaration(exportNode, declaration) {
    for (const declarator of declaration.declarations) {
      const name = bindingName(declarator.id);
      const initializer = unwrapExpression(declarator.init);
      const target = name === null ? undefined : bindings.get(name);
      if (isFunction(initializer) || target?.kind === "function") {
        checkFunction(declarator, exportNode, name ?? "<anonymous>");
      } else if (isClass(initializer)) {
        checkClass(initializer, exportNode, name);
      } else if (target?.kind === "class") {
        checkClass(target.classNode, exportNode, name);
      }
    }
  }

  function checkExportedDeclaration(node, declaration) {
    if (isFunction(declaration)) {
      checkFunction(declaration, node, functionName(declaration));
    } else if (isClass(declaration)) {
      checkClass(declaration, node);
    } else if (declaration?.type === "VariableDeclaration") {
      checkVariableDeclaration(node, declaration);
    }
  }

  function checkDefaultExport(node) {
    const declaration = unwrapExpression(node.declaration);
    if (isFunction(declaration)) {
      checkFunction(declaration, node, functionName(declaration));
    } else if (isClass(declaration)) {
      checkClass(declaration, node);
    } else {
      const name = identifierName(declaration);
      const binding = name === null ? undefined : bindings.get(name);
      if (binding?.kind === "function") {
        checkFunction(binding.target, binding.docsNode, name);
      } else if (binding?.kind === "class") {
        checkClass(binding.classNode, binding.docsNode, name);
      }
    }
  }

  function checkAliases(program) {
    for (const statement of program.body) {
      if (
        statement.type !== "ExportNamedDeclaration" ||
        statement.declaration !== null ||
        statement.source !== null
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        const localName = identifierName(specifier.local);
        const exportedName = identifierName(specifier.exported) ?? localName ?? "<anonymous>";
        const binding = localName === null ? undefined : bindings.get(localName);
        if (binding?.kind === "function") {
          checkFunction(binding.target, binding.docsNode, exportedName);
        } else if (binding?.kind === "class") {
          checkClass(binding.classNode, binding.docsNode, exportedName);
        }
      }
    }
  }

  return {
    Program(node) {
      bindings = buildBindings(node);
    },
    ExportNamedDeclaration(node) {
      checkExportedDeclaration(node, node.declaration);
    },
    ExportDefaultDeclaration(node) {
      checkDefaultExport(node);
    },
    "Program:exit"(node) {
      checkAliases(node);
    },
  };
}

export default {
  meta: {
    name: "holycodex",
  },
  rules: {
    "require-jsdoc": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require JSDoc comments on exported functions, classes, and public class methods.",
        },
      },
      create: createRule,
    },
  },
};
