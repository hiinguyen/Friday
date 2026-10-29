import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map();

// Returns a list of human-readable errors, empty when `data` matches `schema`.
export function validateSchema(schema, data) {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(data)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`.trim());
}
