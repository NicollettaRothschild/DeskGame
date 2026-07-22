import { isImageQuery, isSpatialImageQuery } from './ArvisImageSkill';
import { isMeshQuery } from './ArvisMeshSkill';
import { isMusicQuery } from './ArvisMusicSkill';
import { isNewsQuery } from './ArvisNewsSkill';

/** Server-side OpenClaw / MD skill names (see https://arvis.space/api/skills). */
const DEFAULT_FLOW_GARDEN_SKILLS = ['web surfer', 'google'];
const NEWS_FLOW_GARDEN_SKILLS = ['web surfer', 'google', 'job scout'];
/** Image generation is handled server-side via /image in /api/chat; web surfer helps fetch references. */
const IMAGE_FLOW_GARDEN_SKILLS = ['web surfer', 'google'];
/** Spatial images reuse /image generation, then spatialize locally via Spatial Image + RSG. */
const SPATIAL_IMAGE_FLOW_GARDEN_SKILLS = ['web surfer', 'google'];
/** Music generation is handled via /music in /api/chat plus on-device Lyria playback. */
const MUSIC_FLOW_GARDEN_SKILLS = ['web surfer', 'google'];
/** 3D generation is handled via /mesh in /api/chat; Snap3D runs locally through RSG. */
const MESH_FLOW_GARDEN_SKILLS = ['web surfer', 'google', 'snap3d'];

export function resolveAgentSkillsForMessage(message: string): string[] {
  if (isMeshQuery(message)) {
    return MESH_FLOW_GARDEN_SKILLS;
  }
  if (isImageQuery(message)) {
    return isSpatialImageQuery(message)
      ? SPATIAL_IMAGE_FLOW_GARDEN_SKILLS
      : IMAGE_FLOW_GARDEN_SKILLS;
  }
  if (isMusicQuery(message)) {
    return MUSIC_FLOW_GARDEN_SKILLS;
  }
  if (isNewsQuery(message)) {
    return NEWS_FLOW_GARDEN_SKILLS;
  }
  return DEFAULT_FLOW_GARDEN_SKILLS;
}
