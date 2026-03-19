Review the Develosaur project status and provide insights.

## Instructions

You are connected to a Develosaur project via MCP. The user wants a project status review.

1. **Get project stats** — call `get_project` for high-level numbers
2. **Read full tree** — call `get_tree` with `include_completed: true` and `max_depth: 2` for the big picture
3. **Read active tree** — call `get_tree` with `include_completed: false` for current work
4. **List tags** — call `list_tags` to understand categorization
5. **Analyze and report**:

   ### Project Health
   - Overall completion percentage
   - Number of active vs completed tasks
   - Are there orphaned/rogue nodes that need organization?

   ### In Progress
   - What is actively being worked on?
   - Are any tasks stale (created long ago, never updated)?

   ### Blocked or At Risk
   - Tasks with `blocked_by` dependencies
   - Tasks with high heat that haven't been addressed

   ### Recommended Next Steps
   - What should be prioritized next and why?
   - Are there tasks that should be broken down further?
   - Any structural improvements (reorganize branches, merge related tasks)?

   ### Cleanup Suggestions
   - Nodes to merge or remove
   - Tags to create or retire
   - Missing deadlines or priority scores
