# Otto-to-Otto manual smoke checklist

Two real machines: **Mac** and **Bazzite**. Run every scenario on both ends where noted. Use the exact strings below; a mismatch is a failure.

## Ground rules

- [ ] Remote must be enabled on the target machine: Settings → Mobile remote on the target. Without it, delegation fails with `<machine>'s Otto isn't reachable — is it on and is Remote enabled in its settings?`
- [ ] Bridge port is 17829. Check the target's Mobile remote endpoint is listening on 17829 before pairing.
- [ ] After pairing, start a new conversation (`/n`) before the delegation tools appear. Tools are not present in a conversation that started before pairing.

## Scenario 1: Pair Mac → Bazzite

Setup: Bazzite is the machine that will ask. Mac is the target. Mac Otto is running, Remote enabled.

Steps:
1. [ ] On Mac: Settings → Mobile remote → Pair a device. Copy the pairing link.
2. [ ] On Bazzite: Settings → Other machines. Paste the link into **Pairing link**. Leave **Name** as the auto-filled host label or type `mac`.
3. [ ] Click **Add machine**.

Expected:
- [ ] The Paired machines list shows the Mac with a green online dot (`aria-label="online"`).
- [ ] The line `Start a new conversation (/n) to use it.` appears under the list.
- [ ] Start a new conversation (`/n`) on Bazzite. The delegation tools are now available.
- [ ] Negative: reusing an expired link shows `That link has expired — make a new one on the other machine.`
- [ ] Negative: adding the same name twice shows `You already have a machine called "mac".`
- [ ] Negative: a link to an unreachable host shows `Couldn't reach that machine.`
- [ ] Forget: clicking **Forget** shows the confirm dialog `Forget "mac"? You'll need a new pairing link to add it again.` Do not confirm yet.

## Scenario 2: Quit an app on the Mac from Bazzite

Setup: Scenario 1 complete. Slack is running on the Mac. Bazzite has a new conversation (`/n`).

Steps:
1. [ ] On Bazzite, type: `quit the Slack app on my mac`.
2. [ ] Watch the delegation card on Bazzite.
3. [ ] Confirm Slack is closed on the Mac.

Expected:
- [ ] The tool row reads `Working on mac`.
- [ ] The delegation card header shows `mac` and status `Working`.
- [ ] Slack quits on the Mac.
- [ ] The final tool result is the Mac's answer, not an error string.

## Scenario 3: Sunshine investigation from Mac, approve a destructive step locally

Setup: Bazzite is paired as a machine on the Mac (repeat Scenario 1 in the other direction if needed). Sunshine is installed on Bazzite. Mac has a new conversation (`/n`).

Steps:
1. [ ] On Mac, ask: `Investigate why Sunshine stopped streaming on bazzite.`
2. [ ] When Bazzite proposes a destructive step, the approval card appears on the Mac.
3. [ ] On the Mac, approve that step.

Expected:
- [ ] The approval card appears in the Mac's delegation card, not on Bazzite's screen.
- [ ] Approving on the Mac runs the step on Bazzite.
- [ ] The delegation card returns to `Working` and the investigation continues to a final result.

## Scenario 4: Approve one step on the remote screen; local card clears

Setup: Scenario 3 is running. A destructive step is pending.

Steps:
1. [ ] Confirm the approval card is visible on the Mac.
2. [ ] Approve the same step on Bazzite's own screen (not on the Mac).
3. [ ] Watch the Mac.

Expected:
- [ ] The Mac's approval card disappears.
- [ ] The delegation card returns to `Working`.
- [ ] No duplicate approval appears on the Mac after the remote approval.

## Scenario 5: Interrupt from the local Stop button

Setup: Scenario 2 or 3 is running on Bazzite (or Mac) as a delegated task.

Steps:
1. [ ] On the machine that asked, press the **Stop response** button (or `Esc`) while the delegation card shows `Working`.

Expected:
- [ ] The delegation card status changes to `Interrupted`.
- [ ] The tool result reads `Stopped the task on <machine>.`
- [ ] The task stops on the target machine.

## Scenario 6: Delegate while the remote is mid-turn

Setup: Bazzite is mid-turn on a long task. The Mac asks Bazzite to do a second task while the first is still running.

Steps:
1. [ ] On the Mac, send a task that will be delegated to Bazzite (`if_busy` defaults to `ask`).
2. [ ] Read the result.
3. [ ] Repeat with the wait answer: tell the Mac to call again with `wait`, then cancel the wait with **Stop response**.
4. [ ] Repeat with the interrupt answer: tell the Mac to call again with `interrupt`.

Expected:
- [ ] Ask answer: the tool result reads `<machine> is busy with another task. Ask the user whether to wait for it or interrupt it, then call again with if_busy "wait" or "interrupt".` The card shows `Busy`.
- [ ] Wait answer: the card shows `Busy` while it polls. If the first task finishes, the second task starts. If the wait exceeds the cap, the result reads `<machine> is still busy with another task. Ask the user whether to keep waiting or interrupt it.`
- [ ] Wait cancelled with Stop: the tool result reads `Stopped waiting for <machine>.`
- [ ] Interrupt answer: the first task on Bazzite is interrupted and the second task starts. The Mac's card shows `Working`.

## Scenario 7: Kill the remote's network mid-task

Setup: A delegated task is running on Bazzite and the Mac shows `Working`.

Steps:
1. [ ] Disconnect Bazzite's network (for example, `nmcli networking off`) while the task is running.
2. [ ] Wait for the Mac's card to update.
3. [ ] Restore Bazzite's network.

Expected:
- [ ] The Mac's card status changes to `Connection lost`.
- [ ] The tool result reads `Lost connection to <machine>; the task may still be running there.`
- [ ] Reconnecting does not silently resume the old result. The Mac must delegate again (or call `wait_for_machine` if the task is still running on Bazzite).

## Scenario 8: Catastrophic command is auto-denied on a remote task

Setup: A delegated task on Bazzite. The task asks for a catastrophic command (for example, a disk-wiping `rm -rf` on a system path).

Steps:
1. [ ] From the Mac, delegate a task that would run a catastrophic command on Bazzite.
2. [ ] Watch both the Mac and Bazzite screens.

Expected:
- [ ] No approval card appears on the Mac for the catastrophic step.
- [ ] No approval card appears on Bazzite for it either.
- [ ] The step is denied automatically. The delegation card shows the step as denied (not running).
- [ ] The card's note `Approve this one at <machine>.` is shown only when a catastrophic approval is actually pending at the target. It must not appear here.

## Scenario 9: Phone PWA still works

Setup: Phone is paired to the Bazzite Otto through the Mobile remote pairing flow. Remote is enabled on Bazzite. Bridge port 17829.

Steps:
1. [ ] Open the phone PWA from the paired link.
2. [ ] Send a normal prompt: `What is the uptime of this machine?`
3. [ ] Send a prompt that needs a non-catastrophic approval, then approve it from the phone.
4. [ ] Reconnect the phone after toggling Wi-Fi off and on.

Expected:
- [ ] The PWA loads and shows the paired conversation.
- [ ] The uptime reply streams in and completes.
- [ ] The approval card appears on the phone and approving it lets the step run.
- [ ] After reconnecting, the PWA resumes the conversation without a re-pair.
