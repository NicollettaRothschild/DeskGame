# Desk Game

Desk Game is a Lens Studio experience for Spectacles (2024). It combines a
spatial goal garden with three companions:

- **Buddy** — onboarding, voice commands, goals, and garden feedback
- **Cursor** — coding tasks sent to a paired Mac bridge
- **Claude** — coding and repository questions sent to a paired Mac bridge

The project intentionally targets **Lens Studio 5.15.4**. Do not upgrade it to
5.22 or newer unless Spectacles (2024) compatibility has been revalidated.

## Open and run

1. Install Lens Studio 5.15.4.
2. Open `Desk Top Game.esproj`.
3. In Project Info, confirm **Lens Works On → Spectacles**.
4. Compile the project and start Preview.
5. For device testing, connect Spectacles (2024) and run the Lens on device.

The checked-in project file already declares Spectacles compatibility. If Lens
Studio still reports that no target is selected, reselect Spectacles in Project
Info, save, and restart Lens Studio; this is usually stale editor state.

## First-run journey

The Agent Center panel explains the two supported paths:

- Say **“start demo”** for a credential-free preview. Demo responses are
  simulated and never edit files.
- Say **“pair my Mac”**, then open `https://arvis.space/specs/` on the Mac and
  enter the pairing code shown in the Lens.

After pairing:

1. Say **“use Cursor”** or **“use Claude”**.
2. Say **“show repositories”** and select an allowlisted workspace.
3. Optionally say **“show models”** and select a model.
4. Hold the matching Cursor or Claude buddy and speak, or say **“ask Cursor
   to …”** / **“ask Claude to …”** without holding it. The buddies follow
   your hand while held.
5. Progress, errors, approval states, and final responses appear in Agent
   Center and on the selected buddy.

Provider credentials belong on the Mac bridge. Never paste API keys, tokens,
personal repository paths, or device secrets into Lens Studio inputs, source
files, scene files, logs, or commits.

## Interaction safety

- The main yellow Buddy and scene props can be grabbed to move them.
- Hold Cursor or Claude to move them and start speech recognition; release to
  submit the task. Their native manipulation components stay disabled on
  Spectacles, and the safer trigger/update movement path is used instead.
- Global **“ask Cursor/Claude to …”** voice commands provide a hands-free
  alternative.
- Interaction components are authored in the scene. Do not create or
  reconfigure SIK components at runtime.
- The main Buddy's nested pet/poke interaction and automatic camera following
  are disabled for the release configuration.

## Goal garden

The garden supports spoken goals, including distance goals such as walking
20 meters. Goal and plant state are persisted through the anchor controller,
including partial growth and accumulated walking distance. Spawned sticky notes
also persist their transform and text.

Before a submission build, verify:

- Buddy, Cursor, and Claude are visible.
- Buddy can be moved without freezing or terminating the Lens.
- Holding Cursor and Claude moves the buddy, starts speech recognition, updates
  the listening bubble, and submits the correct provider's task on release.
- A spoken 20-meter goal is assigned to a pot and reaches full growth after the
  required distance.
- Restarting the Lens restores anchors, notes, goal progress, and plant growth.
- Demo mode is clearly labeled and live mode never silently falls back to mock
  responses.

## Automated checks

Run the deterministic bridge and Agent Center checks from the repository root:

```sh
bun tests/specs_bridge_client_test.ts
```

The script validates intent parsing, mock session lifecycle, cancellation,
workspace/model selection, and redaction of secrets and local paths.

Release harness inputs such as `runHarness` must remain disabled in the checked-
in scene and metadata. LEAF is not bundled with this Lens Studio 5.15.4 project;
do not copy a partial or newer `Leaf.lspkg` into `Assets/`.

## Project map

- `Assets/Scene.scene` — release scene and serialized component configuration
- `Assets/Prefabs/` — companion and garden prefabs
- `Assets/Scripts/FriendGrab.ts` — main Buddy interaction and onboarding
- `Assets/Scripts/CursorBuddy.ts` — Cursor/Claude companion bridge workflow
- `Assets/Scripts/FlowGardenVoiceCommands.ts` — global voice command routing
- `Assets/Scripts/FlowGardenSpacePanel.ts` — Agent Center and status UI
- `Assets/Scripts/SpecsApiClient.ts` — paired Specs-to-Mac API client
- `Assets/Scripts/AnchorController.ts` — spatial object persistence
- `Assets/Scripts/PlantLifecycle.ts` — goal progress and plant growth
- `tests/specs_bridge_client_test.ts` — deterministic non-device checks

## Troubleshooting

- **Grab causes a device crash:** confirm the coding buddies' manipulation
  components are disabled, the main Buddy uses authored SIK components, and
  ASR is started only by the deferred coding-buddy path—not by a manipulation
  callback. Avoid rapid release/re-grab while the microphone is stopping.
- **Yellow Buddy is missing:** confirm the `friend` scene object is enabled and
  `enableFollowAfterOnboarding` is false in the scene, prefab, and script
  metadata.
- **Mock response appears on device:** keep
  `useMockFallbackWhenUnpaired` disabled and pair the Mac explicitly.
- **TypeScript imports mention `Leaf.lspkg`:** remove the incomplete LEAF
  package or install one that explicitly supports this project version.
- **Live compile times out from tooling:** compile in Lens Studio directly and
  inspect the Logger before treating the build as verified.
