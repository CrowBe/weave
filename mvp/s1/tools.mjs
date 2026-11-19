// The tool catalogue for the System 1 evaluation. Every tool runs against
// fixtures; nothing here touches a real account. `floor` is the lowest approval
// level the tool may run at: reads are auto, sends, shares and deletes always ask.

const arg = (instructions, required = true) => ({ instructions, required });
const fixture = (name) => async (args) => ({ fixture: name, args });

export const googleTools = {
  gmail_search: {
    description: "Search or list email in the user's Gmail inbox, for example unread or today's mail.",
    floor: "auto",
    args: { query: arg("What to search for in the mailbox, as written.") },
    run: fixture("gmail_search"),
  },
  gmail_send: {
    description: "Send an email or reply from the user's Gmail.",
    floor: "approve",
    args: { to: arg("Recipient name or email address."), topic: arg("What the email says or is about.") },
    run: fixture("gmail_send"),
  },
  calendar_list: {
    description: "List events on a calendar for a day or range.",
    floor: "auto",
    args: { when: arg("The day or date range, as written.") },
    run: fixture("calendar_list"),
  },
  calendar_create: {
    description: "Create an event on the user's calendar.",
    floor: "auto",
    args: { title: arg("Event title or what it is."), when: arg("Day and time of the event, as written.") },
    run: fixture("calendar_create"),
  },
  drive_search: {
    description: "Find files or folders in Google Drive.",
    floor: "auto",
    args: { query: arg("File or folder name or description to search for.") },
    run: fixture("drive_search"),
  },
  drive_move: {
    description: "Move or rename a file or folder in Google Drive.",
    floor: "auto",
    args: { item: arg("The file or folder being moved, as named."), destination: arg("Folder it moves to.") },
    run: fixture("drive_move"),
  },
  drive_share: {
    description: "Share a Drive file or folder with another person.",
    floor: "approve",
    args: { item: arg("The file or folder being shared."), person: arg("Who it is shared with.") },
    run: fixture("drive_share"),
  },
  drive_trash: {
    description: "Delete files or folders from Google Drive.",
    floor: "approve",
    args: { item: arg("The files or folder being deleted.") },
    run: fixture("drive_trash"),
  },
  docs_edit: {
    description: "Edit the text of a Google Doc.",
    floor: "auto",
    args: { document: arg("The document's name."), change: arg("The edit to make, as written.") },
    run: fixture("docs_edit"),
  },
};

// The legacy simulation's catalogue (legacy/wvops/s1-sim/e2e10), so its ten tasks
// can run through the same loop.
export const simTools = {
  cancel_order: {
    description: "Cancel an order by id",
    floor: "auto",
    args: { order_id: arg("Order id exactly as written.") },
    run: fixture("cancel_order"),
  },
  refund_order: {
    description: "Refund an order by id",
    floor: "approve",
    args: { order_id: arg("Order id exactly as written.") },
    run: fixture("refund_order"),
  },
  gh_pr_list: {
    description: "List pull requests for a repo/path",
    floor: "auto",
    args: { repo: arg("owner/repo") },
    run: fixture("gh_pr_list"),
  },
  gh_pr_get: {
    description: "Get one PR by number",
    floor: "auto",
    args: { repo: arg("owner/repo"), number: arg("PR number as digits only.") },
    run: fixture("gh_pr_get"),
  },
  gh_pr_create: {
    description: "Open a draft or ready PR",
    floor: "auto",
    args: { repo: arg("owner/repo"), title: arg("PR title") },
    run: fixture("gh_pr_create"),
  },
  gh_branch_delete: {
    description: "Delete a remote branch",
    floor: "approve",
    args: { repo: arg("owner/repo"), branch: arg("Branch name") },
    run: fixture("gh_branch_delete"),
  },
  linear_create: {
    description: "Create a Linear issue",
    floor: "auto",
    args: { title: arg("Issue title"), team: arg("Linear team key or name", false) },
    run: fixture("linear_create"),
  },
  slack_post: {
    description: "Post a message to a Slack channel",
    floor: "approve",
    args: { channel: arg("Channel name") },
    run: fixture("slack_post"),
  },
  save_draft: {
    description: "Save a draft note without posting",
    floor: "auto",
    args: { channel: arg("Channel the draft is for, if any", false) },
    run: fixture("save_draft"),
  },
  read_file: {
    description: "Read a file from a repo at a ref",
    floor: "auto",
    args: { repo: arg("owner/repo"), path: arg("File path") },
    run: fixture("read_file"),
  },
  wipe_account: {
    description: "Permanently delete account data",
    floor: "approve",
    args: { account_id: arg("Account id if stated, else null") },
    run: fixture("wipe_account"),
  },
};
