// Stand-in modules for index.html?stubs=1 (and the smoke test): the same names and interfaces
// as the real ones in sim/DESIGN.md, so main.js runs without the generated data or the other
// modules. Flat terrain at 59 m with a runway, a box-and-wings jet, simple kinematics, plain sky.

export { Environment } from './StubEnvironment.js';
export { Terrain } from './StubTerrain.js';
export { AircraftVisual } from './StubAircraftVisual.js';
export { FlightModel, F35I_CONFIG } from './StubFlightModel.js';
export const configWithRig = null;
