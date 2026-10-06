/**
 * Check that this plugin's Config is projectable into the editable form the
 * plugin-manager page renders.
 *
 * It rebuilds the projection the settings service applies — `volatileForm`,
 * `plainSchema`, and `projectForm` from @deepseek-ai/dsh-settings — over the
 * real schema, so a field that is not live fails here instead of silently
 * rendering a read-only page in the GUI.
 *
 * Run: node dev/verify-config.mjs
 */

import z from '@deepseek-ai/schemastery';
import { Config } from '../index.js';

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

/** Mirror of dsh-settings `volatileForm`: only fields under a volatile node are editable. */
function volatileForm(schema) {
  if (schema.meta.volatile === true || schema.meta.role === 'volatile') return plainSchema(schema);
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      }),
    );
    return Object.keys(dict).length === 0 ? undefined : z.object(dict);
  }
  return undefined;
}

/** Mirror of dsh-settings `plainSchema`: the round trip through JSON is what detaches the form from the live schema. */
function plainSchema(schema) {
  return new z(schema.toJSON());
}

/** Resolve a node of a schema document that holds `uid` references. */
function deref(node) {
  return node !== undefined && node.uid !== undefined ? node.refs ?? node : node;
}

console.log('editable form projection:');
const form = volatileForm(Config);
check('a form exists', form !== undefined);
check('the form is an object schema', form?.type === 'object');
check('delegationBias is projected', form?.dict?.delegationBias !== undefined);
check('timeoutSeconds is projected', form?.dict?.timeoutSeconds !== undefined);

// A schemastery node holds `refs` keyed by uid, so a field is reachable through
// the root's `dict` entry -> that node's `refs`.
const bias = deref(form?.dict?.delegationBias);
const limit = deref(form?.dict?.timeoutSeconds);
check('bias keeps its bounds and default', bias?.meta?.min === 0 && bias?.meta?.max === 100 && bias?.meta?.default === 50, JSON.stringify(bias?.meta));
check('limit keeps its bounds and default', limit?.meta?.min === 0 && limit?.meta?.default === 0, JSON.stringify(limit?.meta));
// The marker stays on the projected field on purpose: the settings service
// re-reads it (`isVolatilePath`) to admit a write, so stripping it would give a
// form that looks editable and refuses to save.
check('the volatile marker survives so writes are admissible', bias?.meta?.role === 'volatile' && limit?.meta?.role === 'volatile');
check('descriptions survive', typeof bias?.meta?.description === 'string' && typeof limit?.meta?.description === 'string');

console.log('values the page would show:');
const resolved = Config['~standard'].validate({});
const projected = Object.fromEntries(
  Object.entries(form?.dict ?? {}).flatMap(([key]) => {
    const field = resolved.value?.[key];
    return field === undefined ? [] : [[key, field]];
  }),
);
check('all fields have a value', projected.delegationBias === 50 && projected.timeoutSeconds === 0, JSON.stringify(projected));

console.log('');
if (failures.length === 0) {
  console.log('all checks passed');
} else {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
