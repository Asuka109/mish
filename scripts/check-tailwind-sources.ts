import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import type * as TypeScript from "typescript";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(resolve(root, "apps/web/package.json"));
const ts = require("typescript") as typeof TypeScript;
const webSourceRoot = resolve(root, "apps/web/src");
const packagesRoot = resolve(root, "packages");
const stylesheetPath = resolve(webSourceRoot, "styles.css");
const stylesheet = readFileSync(stylesheetPath, "utf8");

for (const variant of ["runtime-desktop", "runtime-mobile", "theme-dark"]) {
  if (!stylesheet.includes(`@custom-variant ${variant} `)) {
    throw new Error(`${relative(root, stylesheetPath)} must define the ${variant} variant.`);
  }
}

function filesUnder(directory: string, extensions: ReadonlySet<string>): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, extensions);
    return extensions.has(extname(entry.name)) ? [path] : [];
  });
}

const sourceEntries = [...stylesheet.matchAll(/@source\s+"([^"]+)"/g)].map((match) =>
  resolve(dirname(stylesheetPath), match[1]),
);
const packageSourceRoots = readdirSync(packagesRoot)
  .map((name) => resolve(packagesRoot, name, "src"))
  .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory());
const packageEmitters = packageSourceRoots.filter((sourceRoot) =>
  filesUnder(sourceRoot, new Set([".ts", ".tsx"])).some((path) =>
    /from\s+["']tailwind-variants["']/.test(readFileSync(path, "utf8")),
  ),
);

for (const sourceRoot of packageEmitters) {
  if (!sourceEntries.some((entry) => entry === sourceRoot)) {
    throw new Error(
      `${relative(root, sourceRoot)} emits Tailwind Variants recipes but is missing from ${relative(root, stylesheetPath)} @source entries.`,
    );
  }
}

function inspectTemplateBoundary(path: string, node: ts.TemplateExpression) {
  if (node.head.text && !/\s$/.test(node.head.text)) {
    throw new Error(
      `${relative(root, path)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.pos).line + 1} constructs a Tailwind class fragment before an interpolation.`,
    );
  }
  for (const span of node.templateSpans) {
    if (span.literal.text && !/^\s/.test(span.literal.text)) {
      throw new Error(
        `${relative(root, path)}:${node.getSourceFile().getLineAndCharacterOfPosition(span.pos).line + 1} constructs a Tailwind class fragment after an interpolation.`,
      );
    }
  }
}

function visitSource(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "className" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isTemplateExpression(node.initializer.expression)
    ) {
      inspectTemplateBoundary(path, node.initializer.expression);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "tv" &&
      node.arguments[0]
    ) {
      function rejectRecipeTemplate(child: ts.Node) {
        if (ts.isTemplateExpression(child)) {
          const position = source.getLineAndCharacterOfPosition(child.pos);
          throw new Error(
            `${relative(root, path)}:${position.line + 1} uses interpolation inside a Tailwind Variants recipe.`,
          );
        }
        ts.forEachChild(child, rejectRecipeTemplate);
      }
      rejectRecipeTemplate(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
}

const sourceFiles = [
  ...filesUnder(webSourceRoot, new Set([".ts", ".tsx"])),
  ...packageEmitters.flatMap((sourceRoot) => filesUnder(sourceRoot, new Set([".ts", ".tsx"]))),
];
for (const path of sourceFiles) visitSource(path);

const productionSourceFiles = sourceFiles.filter(
  (path) => !path.includes(".test.") && !path.includes(".browser.test."),
);

const forbiddenStylePatterns = [
  {
    pattern:
      /-\(--(?:mish-(?:color|typography|spacing|radius|shadow)|color|text|font-weight|radius|spacing|shadow)-[^)]+\)/g,
    reason: "bypasses a named Tailwind theme utility",
  },
  {
    pattern:
      /(?:m[trblxy]?|p[trblxy]?|gap(?:-[xy])?|space-[xy]|w|h|size|min-w|max-w|min-h|max-h|top|right|bottom|left|inset(?:-[xy])?|scroll-m[trblxy]?|scroll-p[trblxy]?|leading)-\[\d+(?:\.\d+)?px\]/g,
    reason: "uses a fixed pixel value that belongs on the exact 4px numeric scale",
  },
  {
    pattern: /text-\[\d+(?:\.\d+)?px\]/g,
    reason: "uses an unnamed typography size",
  },
  {
    pattern: /rounded(?:-[trblse]{1,2})?-\[\d+(?:\.\d+)?px\]/g,
    reason: "uses an unnamed radius",
  },
  {
    pattern: /(?:z-\[\d+\]|duration-\[\d+ms\]|opacity-\[(?:0?\.\d+)\])/g,
    reason: "uses an arbitrary value supported by a standard numeric utility",
  },
  {
    pattern: /(?:border|(?:backdrop-)?blur)-\[\d+(?:\.\d+)?px\]/g,
    reason: "uses an unnamed border or blur value",
  },
  {
    pattern: /(?:scale|tracking)-\[[^\]]+\]/g,
    reason: "uses an unnamed scale or tracking value",
  },
  {
    pattern: /(?:flex-\[(?:0_1_auto|1_1_\d+(?:\.\d+)?px)\]|ease-\[[^\]]+\])/g,
    reason: "uses an arbitrary flex or easing value with a native or named utility",
  },
  {
    pattern: /\[html\[data-(?:runtime|theme)=[^\]]+\]_&\]/g,
    reason: "uses a repeated ancestor selector instead of a named custom variant",
  },
  {
    pattern: /data-\[(?:active|highlighted|pressed|starting-style|ending-style|popup-open)\]/g,
    reason: "uses an arbitrary data-presence variant instead of Tailwind's named form",
  },
  {
    pattern: /(?:bg|border|text)-\[color-mix\([^\]]+\)\]/g,
    reason: "uses an unnamed semantic color mix",
  },
  {
    pattern:
      /(?:\[scrollbar-width:none\]|\[overflow-wrap:anywhere\]|\[transform-origin:var\([^\]]+\)\]|\[margin:[^\]]+\]|motion-reduce:\[animation-duration:[^\]]+\])/g,
    reason: "uses an arbitrary declaration with a native or named utility",
  },
  {
    pattern: /(?:@?(?:max|min))-\[\d+px\]/g,
    reason: "uses an unnamed responsive threshold",
  },
  {
    pattern: /\[--[A-Za-z0-9-]+:\d+(?:\.\d+)?px\]/g,
    reason: "assigns a raw pixel value to a component custom property",
  },
  {
    pattern: /shadow-\[[^\]]+\]/g,
    reason: "uses an unnamed shadow recipe",
  },
  {
    pattern: /(?:bg|text|border)-\[(?:#|rgb|hsl|oklch)[^\]]+\]/g,
    reason: "uses an unnamed literal color",
  },
] as const;

for (const path of productionSourceFiles) {
  const source = readFileSync(path, "utf8");
  for (const { pattern, reason } of forbiddenStylePatterns) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      throw new Error(
        `${relative(root, path)}:${line} ${reason}: ${match[0]}. Use a named theme token, an exact numeric utility, or a documented structural exception.`,
      );
    }
  }
}

const modulePaths = filesUnder(webSourceRoot, new Set([".css"])).filter((path) =>
  path.endsWith(".module.css"),
);
for (const modulePath of modulePaths) {
  const moduleSource = readFileSync(modulePath, "utf8");
  if (moduleSource.includes(":global(")) {
    throw new Error(`${relative(root, modulePath)} must not use global selectors.`);
  }

  const consumers = sourceFiles.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    const expectedPath = `./${relative(dirname(path), modulePath).replace(/\\/g, "/")}`;
    const match = source.match(
      new RegExp(
        `import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["']${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      ),
    );
    return match ? [{ binding: match[1], source, path }] : [];
  });
  if (consumers.length === 0) {
    throw new Error(`${relative(root, modulePath)} is not imported through a CSS Module mapping.`);
  }

  const classes = [...moduleSource.matchAll(/^\.([A-Za-z_][\w-]*)/gm)].map((match) => match[1]);
  for (const className of classes) {
    const referenced = consumers.some(({ binding, source }) => {
      const dotReference = new RegExp(`\\b${binding}\\.${className.replace(/-/g, "\\-")}\\b`);
      const bracketReference = new RegExp(`\\b${binding}\\[(?:"${className}"|'${className}')\\]`);
      return dotReference.test(source) || bracketReference.test(source);
    });
    if (!referenced) {
      throw new Error(
        `${relative(root, modulePath)} .${className} is not referenced through its imported mapping.`,
      );
    }
  }
}

console.log(
  `Tailwind source contract valid: ${sourceFiles.length} source files, ${packageEmitters.length} package emitter, and ${modulePaths.length} CSS Modules.`,
);
