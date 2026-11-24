"""Lets `python3 -m smtool` run the same command line as firmware/tools/sm."""

import sys

from .cli import main

sys.exit(main())
