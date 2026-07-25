import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type PrimitiveType = "boolean" | "number" | "string";
type FieldDefinition = PrimitiveType | { optional?: boolean; type: PrimitiveType };
interface SemanticDefinition {
  actions?: string[];
  data: Record<string, FieldDefinition>;
}
interface PresentationSchema {
  actions: string[];
  applicationActions: string[];
  applicationEvents: Record<string, SemanticDefinition>;
  locales: string[];
  messages: Record<string, { args?: Record<string, "string"> }>;
  notifications: Record<string, SemanticDefinition>;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(
  readFileSync(`${root}/packages/presentation-schema/presentation.schema.json`, "utf8"),
) as PresentationSchema;

function assertUnique(label: string, values: readonly string[]) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicate identifiers`);
  }
}

function validateSemanticDefinitions(
  label: string,
  definitions: Record<string, SemanticDefinition>,
) {
  for (const [kind, definition] of Object.entries(definitions)) {
    if (!/^[a-z][a-z0-9.-]*$/u.test(kind)) {
      throw new Error(`${label} kind is not a stable identifier: ${kind}`);
    }
    const actions = definition.actions ?? [];
    assertUnique(`${label} ${kind} actions`, actions);
    for (const action of actions) {
      if (!schema.applicationActions.includes(action)) {
        throw new Error(`${label} ${kind} references unknown action: ${action}`);
      }
    }
    for (const [field, fieldDefinition] of Object.entries(definition.data)) {
      if (!/^[a-z][a-zA-Z0-9]*$/u.test(field)) {
        throw new Error(`${label} ${kind} data field is not camelCase: ${field}`);
      }
      if (!["boolean", "number", "string"].includes(fieldType(fieldDefinition))) {
        throw new Error(`${label} ${kind}.${field} has an unsupported data type`);
      }
    }
  }
}

assertUnique("presentation locales", schema.locales);
assertUnique("native message IDs", Object.keys(schema.messages));
assertUnique("native action IDs", schema.actions);
assertUnique("application action IDs", schema.applicationActions);
validateSemanticDefinitions("notification", schema.notifications);
validateSemanticDefinitions("application event", schema.applicationEvents);

function pascalCase(value: string) {
  return value
    .split(/[.-]/u)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function snakeCase(value: string) {
  return value.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function fieldType(definition: FieldDefinition) {
  return typeof definition === "string" ? definition : definition.type;
}

function optionalField(definition: FieldDefinition) {
  return typeof definition === "object" && definition.optional === true;
}

function zodField(definition: FieldDefinition) {
  const base = `z.${fieldType(definition)}()`;
  return optionalField(definition) ? `${base}.optional()` : base;
}

function rustFieldType(definition: FieldDefinition) {
  const base = { boolean: "bool", number: "u64", string: "String" }[fieldType(definition)];
  return optionalField(definition) ? `Option<${base}>` : base;
}

function renderSemanticTypeScript(
  name: "ApplicationEvent" | "ApplicationNotification",
  definitions: Record<string, SemanticDefinition>,
) {
  const lowerName = name[0].toLowerCase() + name.slice(1);
  const entries = Object.entries(definitions);
  const dataSchemas = entries
    .map(([kind, definition]) => {
      const fields = Object.entries(definition.data)
        .map(([field, fieldDefinition]) => `  ${field}: ${zodField(fieldDefinition)},`)
        .join("\n");
      return `const ${lowerName}${pascalCase(kind)}DataSchema = z\n  .object({\n${fields}\n  })\n  .strict();`;
    })
    .join("\n\n");
  const variants = entries
    .map(([kind, definition]) => {
      const actions = definition.actions ?? [];
      const actionSchema =
        actions.length === 0
          ? "z.array(z.never()).max(0)"
          : `z.array(z.enum(${JSON.stringify(actions)})).max(${actions.length})`;
      return `  z\n    .object({\n      actionIds: ${actionSchema}.refine((ids) => new Set(ids).size === ids.length, "Action IDs must be unique"),\n      data: ${lowerName}${pascalCase(kind)}DataSchema,\n      kind: z.literal(${JSON.stringify(kind)}),\n    })\n    .strict()`;
    })
    .join(",\n");
  const dataByKind = entries
    .map(
      ([kind]) =>
        `  ${JSON.stringify(kind)}: z.infer<typeof ${lowerName}${pascalCase(kind)}DataSchema>;`,
    )
    .join("\n");
  return `${dataSchemas}

export const ${lowerName}KindSchema = z.enum(${JSON.stringify(entries.map(([kind]) => kind))});
export type ${name}Kind = z.infer<typeof ${lowerName}KindSchema>;
export const ${lowerName}Schema = z.discriminatedUnion("kind", [
${variants},
]);
export type ${name} = z.infer<typeof ${lowerName}Schema>;
export interface ${name}DataByKind {
${dataByKind}
}`;
}

function renderSemanticRust(
  name: "ApplicationEvent" | "ApplicationNotification",
  definitions: Record<string, SemanticDefinition>,
) {
  const entries = Object.entries(definitions);
  const dataStructs = entries
    .map(([kind, definition]) => {
      const fields = Object.entries(definition.data)
        .map(([field, fieldDefinition]) => {
          const rustField = snakeCase(field);
          const optional = optionalField(fieldDefinition)
            ? '    #[serde(skip_serializing_if = "Option::is_none")]\n'
            : "";
          return `${optional}    pub ${rustField}: ${rustFieldType(fieldDefinition)},`;
        })
        .join("\n");
      return `#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${pascalCase(kind)}${name}Data {\n${fields}\n}`;
    })
    .join("\n\n");
  const variants = entries
    .map(
      ([kind]) =>
        `    #[serde(rename = ${JSON.stringify(kind)})]\n    ${pascalCase(kind)}(${pascalCase(kind)}${name}Data),`,
    )
    .join("\n");
  const kindArms = entries
    .map(([kind]) => `            Self::${pascalCase(kind)}(_) => ${JSON.stringify(kind)},`)
    .join("\n");
  const actionArms = entries
    .map(([kind, definition]) => {
      const actions = (definition.actions ?? [])
        .map((action) => `ApplicationActionId::${pascalCase(action)}`)
        .join(", ");
      return `            Self::${pascalCase(kind)}(_) => &[${actions}],`;
    })
    .join("\n");
  return `${dataStructs}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum ${name}Content {
${variants}
}
impl ${name}Content {
    pub const fn kind(&self) -> &'static str {
        match self {
${kindArms}
        }
    }
    pub const fn allowed_actions(&self) -> &'static [ApplicationActionId] {
        match self {
${actionArms}
        }
    }
}
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ${name} {
    #[serde(flatten)]
    pub content: ${name}Content,
    pub action_ids: Vec<ApplicationActionId>,
}
impl ${name} {
    pub fn new(content: ${name}Content, action_ids: Vec<ApplicationActionId>) -> Self {
        Self { content, action_ids }
    }
    pub const fn kind(&self) -> &'static str {
        self.content.kind()
    }
    pub fn actions_valid(&self) -> bool {
        self.action_ids.iter().all(|action| self.content.allowed_actions().contains(action))
            && self.action_ids.iter().collect::<std::collections::HashSet<_>>().len()
                == self.action_ids.len()
    }
}`;
}

const messages = Object.entries(schema.messages);
const messageIds = messages.map(([id]) => id);
const rustMessageVariants = messages
  .map(([id, definition]) => {
    const name = pascalCase(id);
    const args = Object.keys(definition.args ?? {});
    return args.length === 0
      ? `    ${name},`
      : `    ${name} { ${args.map((arg) => `${arg}: &'a str`).join(", ")} },`;
  })
  .join("\n");
const rustIdArms = messages
  .map(([id]) => `            Self::${pascalCase(id)} => ${JSON.stringify(id)},`)
  .join("\n");
const rustMessageIdArms = messages
  .map(([id, definition]) => {
    const name = pascalCase(id);
    const pattern =
      Object.keys(definition.args ?? {}).length === 0 ? `Self::${name}` : `Self::${name} { .. }`;
    return `            ${pattern} => NativeMessageId::${name},`;
  })
  .join("\n");
const rustActionArms = schema.actions
  .map((id) => `            Self::${pascalCase(id)} => ${JSON.stringify(id)},`)
  .join("\n");
const rustApplicationActionArms = schema.applicationActions
  .map((id) => `            Self::${pascalCase(id)} => ${JSON.stringify(id)},`)
  .join("\n");
const tsMessageVariants = messages
  .map(([id, definition]) => {
    const fields = Object.keys(definition.args ?? {})
      .map((arg) => `${arg}: string`)
      .join("; ");
    return `  | { id: ${JSON.stringify(id)}${fields ? `; ${fields}` : ""} }`;
  })
  .join("\n");
const tsArgs = messages
  .map(([id, definition]) => {
    const fields = Object.keys(definition.args ?? {})
      .map((arg) => `${arg}: string`)
      .join("; ");
    return `  ${JSON.stringify(id)}: { ${fields} };`;
  })
  .join("\n");

mkdirSync(`${root}/packages/contracts/src/generated`, { recursive: true });
mkdirSync(`${root}/crates/presentation-contract/src`, { recursive: true });

const ts = `// Generated by scripts/generate-presentation-contract.ts; do not edit.
import * as z from "zod";

export const presentationLocales = ${JSON.stringify(schema.locales)} as const;
export type PresentationLocale = (typeof presentationLocales)[number];
export const nativeMessageIds = ${JSON.stringify(messageIds)} as const;
export type NativeMessageId = (typeof nativeMessageIds)[number];
export const nativeActionIds = ${JSON.stringify(schema.actions)} as const;
export type NativeActionId = (typeof nativeActionIds)[number];
export const applicationActionIds = ${JSON.stringify(schema.applicationActions)} as const;
export const applicationActionIdSchema = z.enum(applicationActionIds);
export type ApplicationActionId = z.infer<typeof applicationActionIdSchema>;

export type NativeMessageArgs = {
${tsArgs}
};

export type NativeMessage =
${tsMessageVariants};

${renderSemanticTypeScript("ApplicationNotification", schema.notifications)}

${renderSemanticTypeScript("ApplicationEvent", schema.applicationEvents)}
`;

const rust = `// Generated by scripts/generate-presentation-contract.ts; do not edit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Locale {
    En,
    ZhCn,
}
impl Locale {
    pub const ALL: [Self; 2] = [Self::En, Self::ZhCn];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::ZhCn => "zh-CN",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeMessageId {
${messageIds.map((id) => `    ${pascalCase(id)},`).join("\n")}
}
impl NativeMessageId {
    pub const fn as_str(self) -> &'static str {
        match self {
${rustIdArms}
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeMessage<'a> {
${rustMessageVariants}
}
impl NativeMessage<'_> {
    pub const fn id(self) -> NativeMessageId {
        match self {
${rustMessageIdArms}
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeActionId {
${schema.actions.map((id) => `    ${pascalCase(id)},`).join("\n")}
}
impl NativeActionId {
    pub const fn as_str(self) -> &'static str {
        match self {
${rustActionArms}
        }
    }
}
#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, Hash, PartialEq, serde::Serialize)]
pub enum ApplicationActionId {
${schema.applicationActions
  .map((id) => `    #[serde(rename = ${JSON.stringify(id)})]\n    ${pascalCase(id)},`)
  .join("\n")}
}
impl ApplicationActionId {
    pub const fn as_str(self) -> &'static str {
        match self {
${rustApplicationActionArms}
        }
    }
}

${renderSemanticRust("ApplicationNotification", schema.notifications)}

${renderSemanticRust("ApplicationEvent", schema.applicationEvents)}
`;

writeFileSync(`${root}/packages/contracts/src/generated/presentation.ts`, ts);
writeFileSync(`${root}/crates/presentation-contract/src/generated.rs`, rust);
for (const [command, args] of [
  ["rustfmt", ["--edition", "2024", "crates/presentation-contract/src/generated.rs"]],
  ["pnpm", ["exec", "oxfmt", "--write", "packages/contracts/src/generated/presentation.ts"]],
] as const) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
