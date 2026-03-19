Sync recent work back to the Develosaur project board.

## Context
$ARGUMENTS

## Instructions

You are connected to a Develosaur project via MCP. The user has done some work and wants to update the project board.

1. **Read the tree** — call `get_tree` to see current project state
2. **Find related tasks** — use `find_nodes` to search for tasks matching the work described above
3. **For each related task**:
   - Call `get_node` to see its full content
   - Use `update_node` to add implementation notes to `content_markdown`
   - If the task is complete, use `complete_node` to mark it done
   - If partially done, update the content with progress notes
4. **Create new tasks** — if the work revealed follow-ups or new tasks, create them with `create_node` under the appropriate branch
5. **Update tags** — move tasks from "IN-PROGRESS" to completed, tag new discoveries appropriately
6. **Report** — summarize what you updated on the board

Be precise — only update nodes that directly relate to the work described. Don't over-update.
