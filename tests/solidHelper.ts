import Path from "path";
import {AppRunner} from "@solid/community-server";
import {config} from "dotenv";

/***************************************
 * Title: solidHelper.ts
 * Description: Helper functions for setting up the test environment
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 20/12/2021
 *****************************************/
config();

const port = Number(process.env.PORT);

export function solidUrl(): string {
  return `http://localhost:${port}/`;
}

/**
 * Start a solid server with public AC and file backend
 * @returns {Promise<void>}
 */
export async function runSolid(): Promise<void> {
  await new AppRunner().run(
    {
      mainModulePath: `${__dirname}/`,
      logLevel: 'info',
    },
    Path.join(__dirname, 'file-no-setup.json'),
    {
      rootFilePath: Path.join(__dirname, 'solidPod/'),
      loggingLevel: 'info',
      port: port,
      showStackTrace: false
    }
  );
  return;
}


let running = false;

/**
 * Finishes if the CSS is already running
 * @returns {Promise<void>}
 */
export async function isRunning(): Promise<void> {
  while (!running) {
    try {
      const response = await fetch(solidUrl());
      if (response.status === 200) {
        running = true;
      }
    } catch (e) {
      // console.log('not running yet') // maybe add proper logging
    }
    await sleep(1000);
  }
}

export function sleep(ms: number): Promise<any> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
