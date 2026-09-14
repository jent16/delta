// Shared Claude calls, used by the posting-ingestion script
// (scripts/ingest-role.js) and the resume-matching API (server.js).
//
// Cost model: extraction runs once per posting at ingest and once per resume
// upload. Scoring afterwards is pure SQL. Callers pass the current skills
// vocabulary so extraction reuses canonical names instead of inventing
// near-duplicates.
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic();

// Separate knobs so the bulk posting side and the user-facing resume side
// can run on different models. Both default to Haiku 4.5 for cost.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const INGEST_MODEL = process.env.INGEST_MODEL || DEFAULT_MODEL;
const RESUME_MODEL = process.env.RESUME_MODEL || INGEST_MODEL;

const norm = (s) => String(s).trim().toLowerCase();

// A tool-call input is only complete if the model stopped on its own; a
// max_tokens cutoff leaves a truncated skills array that would silently
// under-count. Surface it instead of scoring against partial data.
function assertComplete(msg, what) {
  if (msg.stop_reason === "max_tokens") {
    throw new Error(`${what}: output cut off at max_tokens — raise the limit or shorten the input`);
  }
}

const SKILL_ITEM = {
  type: "object",
  properties: {
    name: { type: "string", description: "Canonical skill name" },
    category: { type: "string", enum: ["language", "framework", "concept", "tool"] },
  },
  required: ["name", "category"],
};

function postingTool(tracks) {
  return {
    name: "record_posting",
    description:
      "Record the technical skills a job posting asks for, and which specialization track the posting belongs to.",
    input_schema: {
      type: "object",
      properties: {
        skills: {
          type: "array",
          items: {
            ...SKILL_ITEM,
            properties: {
              ...SKILL_ITEM.properties,
              level: {
                type: "string",
                enum: ["required", "preferred"],
                description:
                  "required = the listing treats it as a must-have; preferred = nice-to-have / bonus",
              },
            },
            required: ["name", "category", "level"],
          },
        },
        track: {
          type: "string",
          enum: tracks,
          description: "The single best-fitting specialization for this posting.",
        },
      },
      required: ["skills", "track"],
    },
  };
}

// posting: { title, company, description }
// returns { skills: [{ name, category, level }], track }
async function extractPostingSkills(posting, knownSkillNames, tracks) {
  // Adzuna's public search API returns a truncated description snippet, not
  // the full posting text — extraction quality is bounded by that.
  const msg = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: 2048,
    tools: [postingTool(tracks)],
    tool_choice: { type: "tool", name: "record_posting" },
    messages: [
      {
        role: "user",
        content:
          `Known skill vocabulary (reuse an exact name from this list whenever a mentioned skill matches one): ${knownSkillNames.join(", ")}.\n\n` +
          `Job title: ${posting.title}\nCompany: ${posting.company}\nDescription:\n${posting.description}\n\n` +
          `Extract every distinct technical skill the posting asks for (languages, frameworks, tools, concepts). ` +
          `Mark "required" if the listing treats it as a must-have, "preferred" if it's a nice-to-have/bonus. ` +
          `Only introduce a name outside the known vocabulary if nothing in it is a reasonable match. ` +
          `Then pick the one track from the allowed list that best describes this posting's specialization.`,
      },
    ],
  });
  assertComplete(msg, "posting extraction");
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  if (!toolUse) return { skills: [], track: tracks[tracks.length - 1] };
  return {
    skills: dedupeSkills(toolUse.input.skills || []),
    track: tracks.includes(toolUse.input.track) ? toolUse.input.track : tracks[tracks.length - 1],
  };
}

const RESUME_TOOL = {
  name: "record_resume_skills",
  description: "Record the technical skills a candidate demonstrates in their resume.",
  input_schema: {
    type: "object",
    properties: {
      skills: { type: "array", items: SKILL_ITEM },
    },
    required: ["skills"],
  },
};

// returns { skills: [{ name, category }] }
async function extractResumeSkills(resumeText, knownSkillNames) {
  const msg = await anthropic.messages.create({
    model: RESUME_MODEL,
    max_tokens: 2048,
    tools: [RESUME_TOOL],
    tool_choice: { type: "tool", name: "record_resume_skills" },
    messages: [
      {
        role: "user",
        content:
          `Known skill vocabulary (reuse an exact name from this list whenever a demonstrated skill matches one): ${knownSkillNames.join(", ")}.\n\n` +
          `Resume text:\n${resumeText}\n\n` +
          `Extract every distinct technical skill this candidate has actually demonstrated, through experience, ` +
          `projects, or a skills section — languages, frameworks, tools, concepts. ` +
          `Only introduce a name outside the known vocabulary if nothing in it is a reasonable match. ` +
          `Do not include skills that are only mentioned in passing without evidence of use.`,
      },
    ],
  });
  assertComplete(msg, "resume extraction");
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  return { skills: dedupeSkills(toolUse ? toolUse.input.skills || [] : []) };
}

// Short plain-text explanation of which role the resume fits best today and
// why, given the deterministic scores. One small call per upload.
// scored: [{ role, industry, fitScore, postings, minimum: {have,total,missing} }]
async function explainFit({ targetRoles, scored, resumeSkillNames }) {
  const lines = scored.map(
    (r) =>
      `- ${r.role}${r.industry ? ` (${r.industry})` : ""}: covers ${r.fitScore}% of required skills on average across ${r.postings} postings; ` +
      `minimum skills ${r.minimum.have}/${r.minimum.total}` +
      (r.minimum.missing.length ? ` (missing: ${r.minimum.missing.join(", ")})` : "")
  );
  const msg = await anthropic.messages.create({
    model: RESUME_MODEL,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content:
          `A candidate is targeting: ${targetRoles.join(", ") || "any role"}.\n` +
          `Skills found on their resume: ${resumeSkillNames.join(", ") || "none matched"}.\n\n` +
          `How they score against each role's real postings (higher is better):\n${lines.join("\n")}\n\n` +
          `In 2-4 plain sentences, say which role their resume is most ready for right now and why, ` +
          `and if that differs from what they're targeting, say what concretely closes the gap. ` +
          `Refer only to the skills and numbers above. No headings, no bullet points.`,
      },
    ],
  });
  assertComplete(msg, "fit explanation");
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// Collapse case/whitespace duplicates within one extraction so a posting
// that lists "Python" twice doesn't count twice.
function dedupeSkills(skills) {
  const seen = new Map();
  for (const s of skills) {
    if (!s || !s.name || !String(s.name).trim()) continue;
    const key = norm(s.name);
    const prev = seen.get(key);
    // if the same skill appears as both required and preferred, keep required
    if (!prev || (s.level === "required" && prev.level !== "required")) {
      seen.set(key, { ...s, name: String(s.name).trim() });
    }
  }
  return [...seen.values()];
}

module.exports = {
  anthropic,
  INGEST_MODEL,
  RESUME_MODEL,
  norm,
  extractPostingSkills,
  extractResumeSkills,
  explainFit,
};
