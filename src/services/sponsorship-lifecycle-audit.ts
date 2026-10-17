I'll start by exploring the repository structure to understand the existing conventions, Horizon client, operations service, and output system.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">find / -type d -name "*.git" 2>/dev/null | head; echo "---"; ls -la 2>/dev/null; echo "---"; pwd</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>