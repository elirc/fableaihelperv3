import { z } from 'zod';
import { CONTEXT_LIMITS as limits, contextCharacters } from '../shared/context';

const situationSchema = z.enum(['interview', 'technical', 'client', 'meeting', 'custom']);
export const outputPreferencesSchema = z.object({
  answerStyle: z.enum(['brief', 'balanced', 'detailed']),
  format: z.enum(['spoken', 'talking-points', 'star']),
  tone: z.enum(['conversational', 'confident', 'diplomatic']),
  audience: z.enum(['general', 'technical', 'nontechnical']),
}).strict();
export const outputOverridesSchema = outputPreferencesSchema.partial();

export const scenarioProfileSchema = z.object({
  id: z.string().trim().min(1).max(limits.id),
  name: z.string().trim().min(1).max(limits.name),
  situation: situationSchema,
  background: z.string().max(limits.background),
  instructions: z.string().max(limits.instructions),
  includeResume: z.boolean(),
  includeJobDescription: z.boolean(),
  output: outputOverridesSchema,
}).strict();

export const contextProfilesSchema = z.array(scenarioProfileSchema).min(1).max(limits.profiles)
  .refine((profiles) => new Set(profiles.map((p) => p.id)).size === profiles.length,
    'Context profile IDs must be unique.');

const relatedAnswerSchema = z.object({
  question: z.string().max(limits.relatedQuestion),
  answer: z.string().max(limits.relatedAnswer),
}).strict();

const conversationSchema = z.array(z.object({
  question: z.string().trim().min(1).max(limits.conversationQuestion),
  answer: z.string().trim().min(1).max(limits.conversationAnswer),
}).strict()).max(limits.conversationTurns);

export const contextSnapshotSchema = z.object({
  profileId: z.string().min(1).max(limits.id),
  profileName: z.string().min(1).max(limits.name),
  situation: situationSchema,
  background: z.string().max(limits.background),
  instructions: z.string().max(limits.instructions),
  resume: z.string().max(limits.resume),
  jobDescription: z.string().max(limits.jobDescription),
  personalProfile: z.string().max(limits.personalProfile).optional(),
  customInstructions: z.string().max(limits.customInstructions).optional(),
  conversation: conversationSchema.optional(),
  output: outputPreferencesSchema,
  questionNote: z.string().max(limits.questionNote),
  relatedAnswer: relatedAnswerSchema.optional(),
  refinement: z.string().max(limits.refinement).optional(),
}).strict().refine((context) => contextCharacters(context) <= limits.total,
  'The combined context is too large. Shorten the background or reference material.');

export const answerOptionsSchema = z.object({
  context: conversationSchema.optional(),
  answerStyle: z.enum(['brief', 'balanced', 'detailed']).optional(),
  profileId: z.string().min(1).max(limits.id).optional(),
  overrides: outputOverridesSchema.optional(),
  questionNote: z.string().max(limits.questionNote).optional(),
  snapshot: contextSnapshotSchema.optional(),
  followUp: relatedAnswerSchema.optional(),
  refinement: z.string().max(limits.refinement).optional(),
}).strict();
