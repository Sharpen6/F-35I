// Lets node resolve the browser import map: `node --import ./sim/tests/node-three.mjs some.test.mjs`
// maps 'three' and 'three/addons/...' to the vendored three.js in sim/vendor/three.
import { register } from 'node:module';

const hook = `
const BASE = ${JSON.stringify(new URL('../vendor/three/', import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: BASE + 'build/three.module.js', shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: BASE + 'examples/jsm/' + specifier.slice(13), shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hook));
