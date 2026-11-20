// What Pre-flight says about a target that has tables and no version applied.
import { deployStage, stagePrompt, type TargetState } from "../lib/deploy/init";

const STATE: TargetState = { schemaExists: true, tableCount: 3, hasVersionTable: true, currentVersion: null };

describe("a schema with tables and no version applied", () => {
  it("says nothing was deployed through this app when there is no rollback history", () => {
    const prompt = stagePrompt(STATE, deployStage(STATE), "v1.0.0");
    expect(prompt?.title).toBe("This schema has tables but no recorded version");
    expect(prompt?.body).toContain("nothing has been deployed to it through this app");
  });

  it("says versions were deployed and rolled back when the history shows that", () => {
    const prompt = stagePrompt(STATE, deployStage(STATE), "v1.0.0", true);
    expect(prompt?.title).toBe("This schema has tables but no version applied right now");
    expect(prompt?.body).toContain("deployed here through this app and then rolled back");
    expect(prompt?.body).toContain("v1.0.0 would run first.");
    expect(prompt?.body).not.toContain("nothing has been deployed");
    expect(prompt?.warn).toBe(true);
  });
});
