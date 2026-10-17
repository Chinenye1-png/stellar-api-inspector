I'll start by exploring the existing codebase to understand the conventions and utilities I need to reuse.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">find / -type d -name "stellar*" 2>/dev/null | head -20; echo "---"; ls / 2>/dev/null</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>