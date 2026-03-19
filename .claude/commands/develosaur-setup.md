Set up the Develosaur MCP integration in this project.

## Instructions

Help the user set up the Develosaur MCP connection so Claude can manage their project board.

### Step 1: Check for existing config
Look for a `.develosaur.json` file in the current directory or parent directories (up to 5 levels). If found, report its project name and test the connection by calling `connection_status`.

### Step 2: If no config found
Tell the user:

> To connect this workspace to your Develosaur project:
>
> 1. Open **develosaur.com** and go to your project list
> 2. Click the **MCP download icon** on the project card (Pro subscription required)
> 3. Place the downloaded `.develosaur.json` file in this project's root directory
> 4. **Important**: Add `.develosaur.json` to your `.gitignore` — it contains an API key

### Step 3: Verify .mcp.json
Check if `.mcp.json` exists in the project root with the develosaur entry.

### Step 4: Test connection
Call `connection_status` to verify everything works. Report the project name, node count, and connection status.

### Step 5: Show available commands
Tell the user about the available slash commands:
- `/develosaur-plan` — Plan a new feature with hierarchical task decomposition
- `/develosaur-work` — Check the task board and pick up the next task
- `/develosaur-sync` — Update the board after completing work
- `/develosaur-review` — Get a project status review
