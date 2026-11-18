// Command pipeline-tui shows where a project's pipeline tickets stand and files new work into its tracker,
// through pipeline-plugin's CLI. It needs no agent and no Claude session.
package main

import (
	"cmp"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	plugin := flag.String("plugin", os.Getenv("PIPELINE_PLUGIN"), "the pipeline-plugin checkout (default $PIPELINE_PLUGIN)")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: pipeline-tui [--plugin <pipeline-plugin dir>] [project dir]")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *plugin == "" {
		die("set --plugin or $PIPELINE_PLUGIN to the pipeline-plugin checkout")
	}
	if _, err := os.Stat(filepath.Join(*plugin, "bin", "pipeline.ts")); err != nil {
		die(fmt.Sprintf("no pipeline CLI in --plugin %s: %v", *plugin, err))
	}
	project, err := filepath.Abs(cmp.Or(flag.Arg(0), "."))
	if err != nil {
		die(err.Error())
	}
	if err := newUI(Plugin{Dir: *plugin, Project: project}).Run(); err != nil {
		die(err.Error())
	}
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, "pipeline-tui:", msg)
	os.Exit(1)
}
