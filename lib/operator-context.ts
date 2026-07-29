import { mutate, readCollection } from "./store";
import type { Product } from "./products";

export interface OperatorContext {
  description: string;
  projectNotes: string;
  updatedAt: number | null;
}

const COLLECTION = "operator-context";
const EMPTY: OperatorContext = {
  description: "",
  projectNotes: "",
  updatedAt: null,
};

export async function getOperatorContext(): Promise<OperatorContext> {
  return readCollection<OperatorContext>(COLLECTION, EMPTY);
}

export async function saveOperatorContext(input: {
  description: string;
  projectNotes: string;
}): Promise<OperatorContext> {
  const next: OperatorContext = {
    description: input.description.trim().slice(0, 4_000),
    projectNotes: input.projectNotes.trim().slice(0, 8_000),
    updatedAt: Date.now(),
  };
  return mutate<OperatorContext, OperatorContext>(COLLECTION, EMPTY, () => ({
    next,
    result: next,
  }));
}

export function renderOperatorContext(
  context: OperatorContext,
  products: Product[],
): string {
  const active = products.filter((product) => !product.archived && product.phase !== "paused");
  const sections = [
    context.description ? `ABOUT THE OPERATOR:\n${context.description}` : "",
    active.length
      ? [
          "PROJECTS FROM THE PRIVATE PROJECT LEDGER:",
          ...active.map(
            (product) =>
              `- ${product.name}: ${product.objective} [phase: ${product.phase}]`,
          ),
        ].join("\n")
      : "",
    context.projectNotes ? `ADDITIONAL PROJECT CONTEXT:\n${context.projectNotes}` : "",
  ].filter(Boolean);

  if (!sections.length) return "";
  return [
    "PRIVATE OPERATOR CONTEXT. Use it to personalize answers. Never expose it to an external connector or repeat it unless relevant.",
    ...sections,
  ].join("\n\n");
}
