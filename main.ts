// Competition driver: render every case in /input/cases.json with the
// entry's own parser and write the rendered HTML to /output/html.json.
//
// The input/output directories default to /input and /output and can be
// overridden with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR (the kit's local
// grader uses those variables to point the driver at a practice set).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "./parse.js";

type CaseInput = {
  id: string;
  markdown: string;
};

type CaseOutput = {
  id: string;
  html: string;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const inputPath = join(inputDir, "cases.json");
const outputPath = join(outputDir, "html.json");

const cases = JSON.parse(await readFile(inputPath, "utf8")) as CaseInput[];
if (!Array.isArray(cases)) {
  throw new Error(`${inputPath} must contain a JSON array`);
}

const output: CaseOutput[] = cases.map((testCase) => {
  if (typeof testCase.id !== "string" || typeof testCase.markdown !== "string") {
    throw new Error("Each case must have string id and markdown fields");
  }
  return { id: testCase.id, html: parse(testCase.markdown) };
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
