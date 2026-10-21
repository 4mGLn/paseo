export interface GoalFormValues {
  title: string;
  objective: string;
  criteriaText: string;
}

export interface GoalCreateInput {
  title: string;
  objective: string;
  criteria: string[];
}

/** One acceptance criterion per non-blank line. */
export function parseGoalCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Returns null while the form cannot be submitted (the title is required). */
export function buildGoalCreateInput(values: GoalFormValues): GoalCreateInput | null {
  const title = values.title.trim();
  if (!title) {
    return null;
  }
  return {
    title,
    objective: values.objective.trim(),
    criteria: parseGoalCriteria(values.criteriaText),
  };
}
