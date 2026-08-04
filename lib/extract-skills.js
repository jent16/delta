// Shared Claude-based skill extraction, used by both the role-ingestion
// script (scripts/ingest-role.js) and the resume-matching API (server.js).
// Both callers pass the current skills vocabulary so extraction prefers
// reusing an existing canonical name over inventing near-duplicates.
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic();
const MODEL = process.env.INGEST_MODEL || "claude-haiku-4-5-20251001";

const norm = (s) => s.trim().toLowerCase();

const ROLE_SKILLS_TOOL = {
  name: "record_skills",
  description: "Record the technical skills mentioned in a job posting.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Canonical skill name" },
            level: { type: "string", enum: ["required", "preferred"] },
            category: { type: "string", enum: ["language", "framework", "concept", "tool"] },
          },
          required: ["name", "level", "category"],
        },
      },
    },
    required: ["skills"],
  },
};

// posting: { title, company, description }
async function extractRoleSkills(posting, knownSkillNames) {
  // Adzuna's public search API returns a truncated description snippet, not
  // the full posting text — extraction quality is bounded by that.
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [ROLE_SKILLS_TOOL],
    tool_choice: { type: "tool", name: "record_skills" },
    messages: [
      {
        role: "user",
        content:
          `Known skill vocabulary (reuse an exact name from this list whenever a mentioned skill matches one): ${knownSkillNames.join(", ")}.\n\n` +
          `Job title: ${posting.title}\nCompany: ${posting.company}\nDescription:\n${posting.description}\n\n` +
          `Extract every distinct technical skill mentioned (languages, frameworks, tools, concepts). ` +
          `Mark "required" if the listing treats it as a must-have, "preferred" if it's a nice-to-have/bonus. ` +
          `Only introduce a name outside the known vocabulary if nothing in it is a reasonable match.`,
      },
    ],
  });
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  return toolUse ? toolUse.input.skills : [];
}

const RESUME_SKILLS_TOOL = {
  name: "record_resume_skills",
  description: "Record the technical skills a candidate demonstrates in their resume.",
  input_schema: {
    type: "object",
    properties: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Canonical skill name" },
            category: { type: "string", enum: ["language", "framework", "concept", "tool"] },
          },
          required: ["name", "category"],
        },
      },
    },
    required: ["skills"],
  },
};

async function extractResumeSkills(resumeText, knownSkillNames) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [RESUME_SKILLS_TOOL],
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
  const toolUse = msg.content.find((b) => b.type === "tool_use");
  return toolUse ? toolUse.input.skills : [];
}

module.exports = { anthropic, MODEL, norm, extractRoleSkills, extractResumeSkills };
