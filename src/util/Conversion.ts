/***************************************
 * Title: Conversion
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 10/12/2021
 *****************************************/
import { Store, Writer} from "n3";

const rdfParser = require("rdf-parse").default;
const streamifyString = require('streamify-string');
const storeStream = require("rdf-store-stream").storeStream;

export async function turtleStringToStore(text: string): Promise<Store> {
  return await stringToStore(text, 'text/turtle');
}

export async function ldjsonToStore(text: string): Promise<Store> {
  return await stringToStore(text, 'application/ld+json');
}

export function storeToString(store: Store): string {
  const writer = new Writer();
  return writer.quadsToString(store.getQuads(null, null, null, null));
}

export async function stringToStore(text: string, contentType: string): Promise<Store> {
  const textStream = streamifyString(text);
  const quadStream = rdfParser.parse(textStream, {contentType: contentType});
  return await storeStream(quadStream);
}
