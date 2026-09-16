import { z } from "zod";

export const GRAPHIC_ICONS = ["person", "people", "message", "phone", "heart", "sun", "moon", "clock", "brain", "book", "camera", "microphone", "leaf", "water", "shield", "money", "check", "light", "target"] as const;
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const graphicSceneSchema = z.object({
  kind: z.enum(["illustration", "process", "comparison", "bars"]),
  title: text(48),
  // This is an explanation of speech, not independently verified evidence.
  reason: text(240),
  unit: z.string().max(20).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  nodes: z.array(z.object({
    label: text(28), icon: z.enum(GRAPHIC_ICONS), quote: text(240),
    value: z.number().finite().min(0).max(1e9).nullable(),
    at: z.number().finite().min(0).max(10),
  }).strict()).min(1).max(3),
}).strict().superRefine((scene, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((scene.kind === "illustration" && scene.nodes.length !== 1) ||
    (scene.kind === "comparison" && scene.nodes.length !== 2) ||
    (scene.kind !== "illustration" && scene.nodes.length < 2)) invalid("Wrong number of visual elements");
  if (scene.kind === "bars") {
    if (!scene.unit.trim() || scene.nodes.some(node => node.value === null) || !scene.nodes.some(node => node.value! > 0)) invalid("Charts need a shared unit and positive numeric data");
  } else if (scene.unit || scene.nodes.some(node => node.value !== null)) invalid("Only charts may contain numeric values");
});
export type GraphicScene = z.infer<typeof graphicSceneSchema>;
export const GRAPHIC_KIND_LABELS: Record<GraphicScene["kind"], string> = {
  illustration: "Illustrated idea", process: "Process diagram", comparison: "Visual comparison", bars: "Data chart",
};
