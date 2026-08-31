The panel fills the window

Every tab capped its content at 580–860px — a readable column, and three quarters
empty glass on any real monitor. The caps are gone, and each pane now lays its
content out against the width it is actually given:

- **Settings** flows its cards into as many columns as fit instead of one strip.
- **Backups** puts *Back up now* and *Automatic backups* side by side, with the
  history at full width beneath them.
- **Performance** draws processor and memory on one row, and the charts grew from
  96px to 170px tall, so a spike looks like a spike.
- **Scheduler** tiles task cards sideways before it stacks them.
- The *Add a server* form and the settings sheets centre their column rather than
  hugging the left edge of a wide panel.

Each pane measures itself against the pane, not the window, so the layouts
collapse back to one column when the space is genuinely narrow — a resized
browser tab behaves the same as the app at its minimum size.

## Depth, within the rules

The panel's elevation rule stands: light edges, not drop shadows, because a soft
shadow over near-black reads as dirt. Within it, panels, cards and dialogs now
carry a top-lit gradient from a new `--surface-hi` token; the void behind them
holds two faint lapis glows instead of being a flat black; and the empty screen
wears an isometric grid at the brand mark's own 2:1 pitch, with the mark itself
lit. Lapis remains the only interactive colour.

## Smaller things

- Scrollbars match the theme instead of shipping the stock Windows grey slab.
- Primary buttons are gradient-lit; the confirm dialog blurs what is behind it.
- The server name, vitals strip, chart readouts and pane titles each went up a
  step in scale.
- The Performance tab's time-range picker no longer double-spaces itself against
  the grid beneath it.
