import {readFileSync} from "fs";
import Path from "path";
import {AppRunner} from "@solid/community-server";
import {config} from "dotenv";
import {Store} from "n3";
import {stringToStore} from "../src/util/Conversion";

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
      logLevel: 'error',
    },
    Path.join(__dirname, 'file-no-setup.json'),
    {
      rootFilePath: Path.join(__dirname, 'solidPod/'),
      loggingLevel: 'error',
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

/**
 * Convert a file as a store (given a path). Default will use text/turtle as content type
 * @param path
 * @param contentType
 * @returns {Promise<Store>}
 */
export async function fileAsStore(path: string, contentType?: string): Promise<Store> {
  contentType = contentType ? contentType : 'text/turtle';
  const text = readFileSync(Path.join(path), "utf8");
  return await stringToStore(text, {contentType});
}
