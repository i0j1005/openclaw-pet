import test from "node:test";
import assert from "node:assert/strict";
import { recoverPositionToWorkAreas } from "../dist/tests/position.js";

test("a pet that is still visible keeps its exact anchor", () => {
  const position = { x: 1850, y: 700 };
  assert.deepEqual(recoverPositionToWorkAreas(position, 280, 252, [{ x: 0, y: 0, width: 1920, height: 1080 }]), position);
});

test("a pet stranded on a removed monitor returns inside the nearest display", () => {
  assert.deepEqual(
    recoverPositionToWorkAreas({ x: 2400, y: 900 }, 280, 252, [{ x: 0, y: 0, width: 1920, height: 1040 }]),
    { x: 1640, y: 788 },
  );
});

test("negative-coordinate monitor layouts recover to the correct work area", () => {
  const areas = [
    { x: -1600, y: 0, width: 1600, height: 900 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  ];
  assert.deepEqual(recoverPositionToWorkAreas({ x: -2200, y: 400 }, 280, 252, areas), { x: -1600, y: 400 });
});
