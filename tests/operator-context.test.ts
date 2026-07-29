import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderOperatorContext,
  type OperatorContext,
} from "../lib/operator-context";
import type { Product } from "../lib/products";

const context: OperatorContext = {
  description: "Nino prefers direct answers and dry humor.",
  projectNotes: "FinAI needs an evidence-backed founder review.",
  updatedAt: 1,
};

const products: Product[] = [
  {
    id: "finai",
    name: "FinAI",
    phase: "build",
    phaseSince: 1,
    objective: "Make financial operations trustworthy.",
    working: [],
    blockers: [],
    milestone: { name: "Proof", exit: [] },
  },
  {
    id: "parked",
    name: "Parked experiment",
    phase: "paused",
    phaseSince: 1,
    objective: "Should not enter live context.",
    working: [],
    blockers: [],
    milestone: { name: "None", exit: [] },
  },
];

describe("private operator context", () => {
  it("hands the voice route the operator and active project ledger together", () => {
    const rendered = renderOperatorContext(context, products);
    assert.match(rendered, /Nino prefers direct answers/);
    assert.match(rendered, /FinAI: Make financial operations trustworthy/);
    assert.match(rendered, /FinAI needs an evidence-backed founder review/);
  });

  it("does not put paused projects into live conversation context", () => {
    assert.doesNotMatch(renderOperatorContext(context, products), /Parked experiment/);
  });

  it("states the privacy boundary in the model-facing block", () => {
    assert.match(
      renderOperatorContext(context, products),
      /Never expose it to an external connector/,
    );
  });
});
