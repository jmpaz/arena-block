import { readRedditPage } from "../../packages/core/reddit-browser-reader.ts";
(globalThis as any).ExtensionPreprocessingJS = {
  run(arguments_: { completionFunction(value: Record<string, string>): void }) {
    if (!["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(location.hostname)) {
      arguments_.completionFunction({}); return;
    }
    void readRedditPage().then(value => arguments_.completionFunction({ redditCapture: JSON.stringify(value) }),
      error => arguments_.completionFunction({ redditError: error instanceof Error ? error.message : String(error) }));
  },
};
