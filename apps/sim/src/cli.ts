/**
 * Command line of the simulation tooling (Issue #715).
 *
 *   sim provision [--size small|full] [--backfill-days N] [--mail-url URL]
 *   sim day [--date YYYY-MM-DD]
 *   sim backfill
 *   sim check [--create-issues] [--repo owner/name]
 *   sim plan [--size small|full]
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config";
import { buildPopulation, countKinds } from "./plan";
import { provision, sizeFor } from "./provision/index";
import { runDay } from "./bots/day";
import { loadProgress } from "./bots/context";
import { loadState } from "./state";
import { addDays, dayInTz } from "./tz";
import { runCheck } from "./checker/run";
import { draftIssues, fileIssues } from "./checker/issues";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();
  const log = (line: string) => process.stdout.write(`${line}\n`);

  switch (command) {
    case "plan": {
      const { values } = parseArgs({
        args: rest,
        options: { size: { type: "string", default: "small" } },
      });
      const plan = buildPopulation(
        config.seed,
        "2026-01-01",
        sizeFor(values.size as "full" | "small"),
      );
      for (const tenant of plan.tenants) {
        log(`${tenant.key}: ${tenant.salons.length} salons, ${tenant.persons.length} people`);
        log(`  kinds ${JSON.stringify(countKinds(tenant.persons))}`);
      }
      return 0;
    }
    case "provision": {
      const { values } = parseArgs({
        args: rest,
        options: {
          size: { type: "string", default: "small" },
          "backfill-days": { type: "string", default: "0" },
          "mail-url": {
            type: "string",
            default: process.env.SIM_MAIL_URL ?? "http://127.0.0.1:18125",
          },
        },
      });
      await provision(config, {
        size: values.size as "full" | "small",
        backfillDays: Number(values["backfill-days"]),
        mailUrl: values["mail-url"] as string,
        log,
      });
      return 0;
    }
    case "day": {
      const { values } = parseArgs({
        args: rest,
        options: { date: { type: "string" }, force: { type: "boolean", default: false } },
      });
      const dayLog = await runDay(config, { date: values.date, force: values.force, log });
      log(`day ${dayLog.date}: ${JSON.stringify(dayLog.actions)}`);
      log(`anomalies ${dayLog.anomalies.length}, intents ${dayLog.intents.length}`);
      return dayLog.anomalies.length === 0 ? 0 : 3;
    }
    case "backfill": {
      // Replays the days from the epoch up to today in order, for a run that starts with history.
      const state = loadState(config.stateDir);
      const today = dayInTz(new Date(), config.tz);
      const done = new Set(loadProgress(config.stateDir).daysSimulated);
      for (let day = state.plan.epoch; day <= today; day = addDays(day, 1)) {
        // A day that already ran is never run twice: its entries and requests exist.
        if (done.has(day)) continue;
        const dayLog = await runDay(config, { date: day });
        log(`day ${day}: anomalies ${dayLog.anomalies.length}, intents ${dayLog.intents.length}`);
      }
      return 0;
    }
    case "check": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "create-issues": { type: "boolean", default: false },
          repo: { type: "string", default: process.env.SIM_ISSUE_REPO ?? "sebastianzabel/clokr" },
          "skip-perf": { type: "boolean", default: false },
          rebaseline: { type: "boolean", default: false },
        },
      });
      const dbUrl = process.env.SIM_DB_URL;
      if (!dbUrl) throw new Error("SIM_DB_URL (the read-only connection) is required");
      const report = await runCheck(config, {
        dbUrl,
        skipPerf: values["skip-perf"],
        rebaseline: values.rebaseline,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      const drafts = draftIssues(report.findings, { date: report.date, seed: report.seed });
      const filed = await fileIssues(drafts, {
        repo: values.repo as string,
        create: values["create-issues"] as boolean,
      });
      for (const f of filed) log(`issue ${f.action}: ${f.key}`);
      if (report.invariants.some((i) => i.status === "error")) return 1;
      return report.ok ? 0 : 2;
    }
    default:
      console.error("Usage: sim <plan|provision|day|check> [options]");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
