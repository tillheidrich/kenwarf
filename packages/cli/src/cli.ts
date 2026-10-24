#!/usr/bin/env node
import { fuehreAus } from './programm.js';

process.exitCode = await fuehreAus(process.argv.slice(2));
