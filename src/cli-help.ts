import { Command, Help, type Option } from "commander";

function outputWidth(stream: NodeJS.WriteStream): number {
  const columns = stream.columns ?? Number(process.env.COLUMNS);
  return Number.isInteger(columns) && columns >= 20 && columns <= 1000 ? columns : 80;
}

const optionGroups: Record<string, string[]> = {
  "Sources:": ["extra", "substackCapture", "redditCapture", "threadExpansion", "manifest", "scope", "author", "select", "maxPosts", "maxRequests", "depth", "parentHeight"],
  "Media:": ["media", "frame", "videoFrameThreshold", "mediaOrder", "audio"],
  "Text and quotes:": ["quote", "quoteDepth", "quoteDates", "quoteAuthorLink", "separator"],
  "Files and output:": ["output", "outputDir", "plan", "layout", "canvas", "minScale", "descriptions", "json", "human", "verbose"],
  "Saving:": ["to", "force", "dryRun", "initiator", "agent", "publish"],
  "Configuration:": ["config", "profile", "daemon"],
};

const commandGroups: Record<string, string[]> = {
  "Compose and preview:": ["resolve", "plan", "render", "thread"],
  "Save and recover:": ["publish", "save-intent", "save-status", "cancel-save", "retry-save", "replay-save", "replan-save", "resume"],
  "Inspect:": ["status", "metadata", "inspect", "attempt"],
  "Service and setup:": ["picker", "serve", "mcp", "version"],
};

export function configureCliHelp(program: Command): void {
  const configure = (command: Command) => {
    command.configureOutput({
      getOutHelpWidth: () => outputWidth(process.stdout),
      getErrHelpWidth: () => outputWidth(process.stderr),
    });
    command.configureHelp({
      minWidthToWrap: 12,
      argumentTerm(argument) {
        const name = argument.name() + (argument.variadic ? "..." : "");
        return argument.required ? `<${name}>` : `[${name}]`;
      },
      groupItems<T extends Command | Option>(items: T[], visible: T[], getGroup: (item: T) => string): Map<string, T[]> {
        const groups = Help.prototype.groupItems(items, visible, getGroup);
        const order = [...Object.keys(optionGroups), "Options:", ...Object.keys(commandGroups), "Commands:"];
        return new Map([...groups].sort(([a], [b]) => {
          const rank = (heading: string) => order.includes(heading) ? order.indexOf(heading) : order.length;
          return rank(a) - rank(b);
        }));
      },
      prepareContext(context) {
        Help.prototype.prepareContext.call(this, context);
        this.styleTitle = context.outputHasColors
          ? text => `\u001b[1;36m${text}\u001b[0m`
          : text => text;
      },
      formatItem(term, termWidth, description, helper) {
        const width = helper.helpWidth ?? 80;
        const remaining = width - termWidth - 4;
        if (width >= 80 && remaining >= 32) {
          return Help.prototype.formatItem.call(this, term, termWidth, description, helper);
        }
        const label = helper.boxWrap(term, width - 2).replace(/\n/g, "\n  ");
        if (!description) return `  ${label}`;
        const body = helper.boxWrap(description, width - 4).replace(/\n/g, "\n    ");
        return `  ${label}\n    ${body}\n`;
      },
      formatHelp(command, helper) {
        const text = Help.prototype.formatHelp.call(this, command, helper);
        const newline = text.indexOf("\n");
        const usage = helper.boxWrap(text.slice(0, newline), (helper.helpWidth ?? 80) - 2).replace(/\n/g, "\n  ");
        return usage + text.slice(newline);
      },
      formatItemList(heading, items, helper) {
        return items.length ? [helper.styleTitle(heading), ...items.map((item, index) => index === items.length - 1 ? item.trimEnd() : item), ""] : [];
      },
    });
    for (const option of command.options) {
      const group = Object.entries(optionGroups).find(([, names]) => names.includes(option.attributeName()));
      if (group) option.helpGroup(group[0]);
    }
    for (const child of command.commands) {
      const group = Object.entries(commandGroups).find(([, names]) => names.includes(child.name()));
      if (group) child.helpGroup(group[0]);
      configure(child);
    }
  };
  configure(program);
}
