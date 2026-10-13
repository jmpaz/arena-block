import { composePlan } from '../../src/compose.ts';
import { publicationFields } from '../../src/capture.ts';
(globalThis as any).captureCompose = (input: string) => {
  const {posts, policy} = JSON.parse(input);
  const plan = composePlan(posts, policy);
  return JSON.stringify({plan, fields: publicationFields(plan)});
};
