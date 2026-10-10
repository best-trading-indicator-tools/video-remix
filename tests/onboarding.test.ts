import assert from "node:assert/strict";
import { test } from "node:test";
import { ONBOARDING_SESSION_KEY, rememberOnboarding, shouldShowOnboarding, TOUR_STEPS, INTRO_STEPS } from "../src/onboarding-steps.js";

test("the tour appears once per browser and remains closed across reloads", () => {
  const values = new Map<string, string>();
  const session = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(shouldShowOnboarding(session), true);
  rememberOnboarding(session);
  assert.equal(values.get(ONBOARDING_SESSION_KEY), "seen");
  assert.equal(shouldShowOnboarding(session), false);
  const reloadedSession = { ...session };
  assert.equal(shouldShowOnboarding(reloadedSession), false);
  values.clear();
  assert.equal(shouldShowOnboarding(session), true);
});

test("unavailable browser storage never blocks opening or dismissing the tour", () => {
  const blocked = { getItem: () => { throw new Error("Storage blocked"); }, setItem: () => { throw new Error("Storage blocked"); } };
  assert.equal(shouldShowOnboarding(blocked), true);
  assert.doesNotThrow(() => rememberOnboarding(blocked));
});

test("every topic has a stable unique identity and destinations cover all editing views", () => {
  assert.equal(new Set(TOUR_STEPS.map(step => step.id)).size, TOUR_STEPS.length);
  assert.equal(TOUR_STEPS[0].id, "welcome");
  assert.equal(TOUR_STEPS.at(-1)?.id, "ready");
  for (const mode of ["auto", "manual", "shorts"]) assert.ok(TOUR_STEPS.some(step => step.destination?.mode === mode));
  for (const view of ["studio", "exports", "history", "settings"]) assert.ok(TOUR_STEPS.some(step => step.destination?.view === view));
  for (const step of TOUR_STEPS.slice(1)) {
    assert.ok(step.target, step.id);
    assert.ok(step.destination, step.id);
  }
});

test("first-use introduction starts at API setup before importing and retains optional chat editing", () => {
  assert.equal(INTRO_STEPS.length, 5);
  assert.deepEqual(INTRO_STEPS.map(step => step.destination?.view), ["settings", "studio", "studio", "exports", "exports"]);
  const setup = INTRO_STEPS[0];
  assert.equal(setup.id, "intro-api-keys");
  assert.equal(setup.action?.destination.view, "settings", "The setup action must leave users in the editable Settings page");
  assert.equal(setup.action?.label, "Open Settings");
  assert.ok(TOUR_STEPS.some(step => step.id === "api-keys" && step.action?.destination.view === "settings"));
  assert.equal(INTRO_STEPS.at(-1)?.helpTopic?.id, "mcp");
  assert.ok(TOUR_STEPS.length > INTRO_STEPS.length);
});
