import type { HelpTopic } from "./types";

/** Help for Visualizer. Shown in the Help panel; the blurb is the page header's one line. */
export const visualizerHelp: HelpTopic = {
  title: "Visualizer",
  blurb: "See a schema as a map of tables and the links between them.",
  purpose:
    "Visualizer draws a live map of any schema: its tables, columns and keys, and the foreign key paths between them. Side by side draws two schemas at once, so you can look for differences by eye before you compare them.",
  steps: [
    "Open Visualizer from the menu.",
    "Pick a connection, then one of its schemas. The diagram draws by itself.",
    "Drag to move around and scroll to zoom. The small map in the corner shows where you are.",
    "Click a table to keep it and the tables linked to it lit while the rest fade. Click the background to clear it.",
    "Type in the search box on the diagram to find a table by name.",
    "Switch to Side by side to draw a second schema next to the first. Drag the divider to resize the panes, or double-click it to reset them.",
    "Press Open in Compare to carry the picked schemas over to Compare. Check the order there, then press Compare yourself.",
  ],
  terms: [
    {
      term: "Entity-relationship diagram",
      meaning: "A picture of a schema: one box per table, and a line wherever one table points at another.",
    },
    {
      term: "Table box",
      meaning: "One table. The rows inside the box are its columns, with their keys marked.",
    },
    {
      term: "Foreign key",
      meaning:
        "A rule that links a column in one table to a key in another table. The diagram draws it as a line between the two boxes.",
    },
    {
      term: "Single",
      meaning: "One schema fills the page.",
    },
    {
      term: "Side by side",
      meaning: "Two schemas in two panes, for example dev and production. Each pane has its own connection and schema.",
    },
    {
      term: "Divider",
      meaning: "The bar between the two panes.",
    },
    {
      term: "Open in Compare",
      meaning:
        "Opens Compare with the left schema as the source and the right one as the target. Nothing is compared until you press Compare there.",
    },
  ],
  problems: [
    {
      problem: "The page says Add a connection first.",
      fix: "The visualizer reads a live database, so it needs a saved PostgreSQL connection to draw from. Add one on the Connections page.",
    },
    {
      problem: "The page says Could not load your connections.",
      fix: "The saved connections could not be read just now. Reload the page to try again.",
    },
    {
      problem: "The schema list is empty.",
      fix: "Pick a connection first. If the list stays empty, check that the schema exists in that database, then reload the page. A very large database can take a while to read.",
    },
    {
      problem: "There is no Side by side switch.",
      fix: "A small screen shows one pane only, because two panes do not fit. Turn the phone sideways or use a wider window.",
    },
    {
      problem: "The diagram feels slow.",
      fix: "Very large schemas are heavy to draw. The page works best with fewer than 500 tables. Reload the page if it stays sluggish.",
    },
  ],
};
