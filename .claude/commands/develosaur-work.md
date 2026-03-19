Check the Develosaur task board and pick up the next task.

## Instructions

You are connected to a Develosaur project via MCP. The user wants you to check the board and start working.

1. **Read the tree** — call `get_tree` to see all incomplete tasks
2. **Identify priorities** — look for:
   - Tasks tagged "IN-PROGRESS" (resume these first)
   - High `v_score` tasks (most valuable)
   - Tasks under active feature branches
3. **Pick one task** — choose the most impactful task you can complete
4. **Get full details** — call `get_node` on your chosen task to read its content and context
5. **Update status** — tag it "IN-PROGRESS" using `update_node`
6. **Do the work** — implement what the task describes in the actual codebase
7. **Update the node** — add implementation notes to `content_markdown` as you work
8. **Mark complete** — use `complete_node` when done
9. **Check for next** — read the tree again and ask if the user wants you to continue

Always keep the project board in sync with reality. If you discover new subtasks during implementation, create them under the appropriate parent with `create_node`.

If a task is blocked, note the blocker in the content and set `blocked_by` with `update_node`.
