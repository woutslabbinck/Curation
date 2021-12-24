/***************************************
 * Title: Conversion
 * Description: Conversion functions
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 10/12/2021
 *****************************************/
import {DataService, DataSet, View} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {Store, Writer} from "n3";
import {ParseOptions} from "rdf-parse/lib/RdfParser";

const rdfParser = require("rdf-parse").default;
const storeStream = require("rdf-store-stream").storeStream;
const streamifyString = require('streamify-string');

export async function turtleStringToStore(text: string, baseIRI?: string): Promise<Store> {
  return await stringToStore(text, {contentType: 'text/turtle', baseIRI});
}

export async function ldjsonToStore(text: string, baseIRI?: string): Promise<Store> {
  return await stringToStore(text, {contentType: 'application/ld+json', baseIRI});
}

/**
 * Converts a store to turtle string
 * @param store
 * @returns {string}
 */
export function storeToString(store: Store): string {
  const writer = new Writer();
  return writer.quadsToString(store.getQuads(null, null, null, null));
}

export async function stringToStore(text: string, options: ParseOptions): Promise<Store> {
  const textStream = streamifyString(text);
  const quadStream = rdfParser.parse(textStream, options);
  return await storeStream(quadStream);
}

export async function memberToString(member: DataSet | DataService | View, baseIRI?: string): Promise<string> {
  const store = await ldjsonToStore(JSON.stringify(member), baseIRI);
  return storeToString(store);
}


