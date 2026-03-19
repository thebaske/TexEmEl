Plan a new feature in the Develosaur project board.

## Instructions

You are connected to a Develosaur project via MCP. The user wants to plan a feature.

1. **Read the current tree** — call `get_tree` to see existing project structure
2. **List available tags** — call `list_tags` to see what tags exist
3. **Ask the user** what feature they want to plan (if not provided as argument: $ARGUMENTS)
4. **Find the right branch** — use `find_nodes` to locate where this feature should live
5. **Build a DEEP hierarchical plan** using `batch_create_nodes`:
   - Level 0: Feature specification node (with markdown description)
   - Level 1: Major phases or work areas
   - Level 2: Concrete tasks within each phase
   - Level 3+: Subtasks, implementation steps, edge cases
   - Use `parent_temp_id` chaining for deep nesting
   - A flat list is NOT acceptable — think like an architect
6. **Set priority scores** — `v_score` (business value 0-10) and `e_score` (effort 0-10) on every task
7. **Tag nodes** with appropriate project tags. If a needed tag doesn't exist, create it with `create_tag`
8. **Set deadlines** on time-sensitive tasks using the `deadline` parameter (YYYY-MM-DD)
9. **Report the plan** — summarize what you created with node IDs

After creating the plan, ask if the user wants you to start implementing it.
