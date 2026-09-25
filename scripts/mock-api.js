// Local stand-in for api.anthropic.com and api.adzuna.com so the pipeline can
// be exercised without spending credits. Returns canned tool_use responses.
const http = require("http");

function anthropicReply(body) {
  const tool = body.tool_choice && body.tool_choice.name;
  const userText = body.messages[0].content;
  let content;
  if (tool === "record_posting") {
    // vary by company so tracks/skills differ per posting
    const isML = /MLCo/.test(userText);
    content = [{
      type: "tool_use", id: "toolu_1", name: "record_posting",
      input: {
        track: isML ? "ML/AI" : "Backend",
        industry: isML ? "Enterprise Software" : "Fintech",
        skills: isML
          ? [
              { name: "python", category: "language", level: "required" },
              { name: "PyTorch", category: "framework", level: "required" },
              { name: "Machine Learning", category: "concept", level: "required" },
              { name: "Git", category: "tool", level: "preferred" },
            ]
          : [
              { name: "Python", category: "language", level: "required" },
              { name: "SQL", category: "language", level: "required" },
              { name: "Git", category: "tool", level: "required" },
              { name: "Docker", category: "tool", level: "preferred" },
              { name: "Python", category: "language", level: "preferred" }, // dup on purpose
            ],
      },
    }];
  } else if (tool === "record_resume_skills") {
    content = [{
      type: "tool_use", id: "toolu_2", name: "record_resume_skills",
      input: { skills: [
        { name: "python", category: "language" },
        { name: "Data Structures", category: "concept" },
        { name: "Algorithms", category: "concept" },
        { name: "Figma", category: "tool" },
      ] },
    }];
  } else if (tool === "record_qualifications") {
    // vary by candidate so evidenced/not-evidenced both get exercised
    const isPM = /Product Manager|roadmap|stakeholder/i.test(userText);
    content = [{
      type: "tool_use", id: "toolu_3", name: "record_qualifications",
      input: { qualifications: [
        { name: "Product Sense", evidenced: isPM, evidence: isPM ? "led feature prioritization for a campus app" : "" },
        { name: "Data-Driven Decision Making", evidenced: true, evidence: "used usage metrics to guide a redesign" },
        { name: "Cross-Functional Collaboration", evidenced: true, evidence: "worked with engineers and designers on FallHacks project" },
        { name: "Communication & Storytelling", evidenced: false, evidence: "" },
        { name: "Strategic & Business Acumen", evidenced: false, evidence: "" },
        { name: "Execution & Ownership", evidenced: true, evidence: "shipped hackathon project end to end in 24 hours" },
      ] },
    }];
  } else {
    content = [{ type: "text", text: "MOCK REASONING: you are most ready for the role with the highest score above." }];
  }
  return {
    id: "msg_mock", type: "message", role: "assistant", model: body.model,
    content, stop_reason: process.env.MOCK_TRUNCATE ? "max_tokens" : "tool_use",
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function adzunaReply() {
  return {
    results: [
      { id: 111, title: "Backend Intern", company: { display_name: "AcmeCo" }, redirect_url: "https://example.com/111", description: "Backend intern, needs Python, SQL." },
      { id: 222, title: "ML Intern", company: { display_name: "MLCo" }, redirect_url: "https://example.com/222", description: "ML intern, PyTorch." },
      { id: 333, title: "Backend Intern 2", company: { display_name: "BetaCo" }, redirect_url: "https://example.com/333", description: "Another backend, \"quoted\", with, commas\nand newline." },
    ],
  };
}

const calls = [];
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/messages")) {
      const body = JSON.parse(raw);
      process.stderr.write(`[mock] anthropic model=${body.model} tool=${body.tool_choice ? body.tool_choice.name : "-"} max_tokens=${body.max_tokens}\n`);
      res.end(JSON.stringify(anthropicReply(body)));
    } else if (req.url.startsWith("/v1/databases/")) {
      process.stderr.write(`[mock] notion GET ${req.url}\n`);
      res.end(JSON.stringify({ properties: {
        Name: { type: "title" }, Company: { type: "rich_text" }, Term: { type: "multi_select" },
        Posted: { type: "date" }, City: { type: "rich_text" }, Link: { type: "url" },
        Status: { type: "status" }, Notes: { type: "rich_text" },
      } }));
    } else if (req.url === "/v1/pages" && req.method === "POST") {
      process.stderr.write(`[mock] notion POST /v1/pages ${JSON.stringify(JSON.parse(raw).properties)}\n`);
      res.end(JSON.stringify({ id: "page-" + Date.now() }));
    } else if (req.url.includes("/v1/api/jobs/")) {
      process.stderr.write(`[mock] adzuna ${req.url.split("?")[0]}\n`);
      res.end(JSON.stringify(adzunaReply()));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
}).listen(4010, () => process.stderr.write("[mock] listening on 4010\n"));
