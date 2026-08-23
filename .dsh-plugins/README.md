# DSH Plugins — durable record
These two plugins were built as dynamic Cordis plugins in the session where they
were created. Dynamic plugins are session-owned and do NOT survive a harness
restart by themselves.

- attach-plugin.js  -> "Image & File Attach"  (paperclip + Ctrl+V, images to model)
- split-plugin.js   -> "Two-Chat Split Layout" (resizable two-chat view tab)

Re-deploy after a restart: give this agent the HOST/CLIENT bodies in these files
via cordis_define, then cordis_run. For TRUE permanence the plugins must be added
to the harness web client source (C:\MIX anti gravity\deepseek-harness) and the
web bundle rebuilt — see the main chat for the current status.
