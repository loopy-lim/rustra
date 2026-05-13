export type CommandSchema = {
  name: string;
  inputType: string;
  outputType: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export type PackageSchema = {
  packageId: string;
  commands: CommandSchema[];
};

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  $ref?: string;
  anyOf?: JsonSchema[];
  enum?: string[];
  title?: string;
  format?: string;
  definitions?: Record<string, JsonSchema>;
  [key: string]: unknown;
};
