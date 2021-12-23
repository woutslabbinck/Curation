/***************************************
 * Title: SolidCommunication
 * Description: utility functions for authenticated communication to a solid pod
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 10/12/2021
 *****************************************/
import {Session} from "@rubensworks/solid-client-authn-isomorphic";
import { Quad, Store, Writer} from "n3";
import {Logger} from "../logging/Logger";
import {turtleStringToStore} from "./Conversion";

const logger = new Logger('SolidCommunication');

export async function fetchResourceAsStore(iri: string, session: Session): Promise<Store> {
  const response = await session.fetch(iri, {
    method: "GET",
    headers: {
      Accept: "text/turtle"
    }
  });
  if (response.status !== 200) {
    logger.debug(`${iri} Could not be fetched | ${response.statusText}`);
    throw Error(`Failed fetching resource at ${iri}`);
  }
  logger.debug(`${iri} fetched`);
  const text = await response.text();
  return await turtleStringToStore(text, iri);
}

export async function putLDJSON(iri: string, session: Session, body: string): Promise<Response> {
  return await putResource(iri, session, body, 'application/ld+json');
}

export async function putTurtle(iri: string, session: Session, body: string): Promise<Response> {
  return await putResource(iri, session, body, 'text/turtle');
}

export async function postResource(containerIRI: string, session: Session, body: string, contentType: string): Promise<Response> {
  const response = await session.fetch(containerIRI, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Link": `<http://www.w3.org/ns/ldp#Resource>; rel="type"`
    },
    body: body
  });
  if (response.status === 201) {
    logger.debug(`Created resource at ${response.url} | status: ${response.status}`);
  } else {
    logger.debug(`Resource was not created at ${containerIRI} | ${response.statusText}`);
    console.log(await response.text());
    throw Error(`Failed creating resource at ${containerIRI}`);
  }
  return response;
}

export async function putResource(iri: string, session: Session, body: string, contentType: string): Promise<Response> {
  const response = await session.fetch(iri, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Link": `<http://www.w3.org/ns/ldp#Resource>; rel="type"`
    },
    body: body
  });
  if (response.status === 201) {
    logger.debug(`Created resource at ${iri} | status: ${response.status}`);
  } else if (response.status === 205) {
    logger.debug(`Updated contents at ${iri} | status: ${response.status}`);
  } else {
    logger.debug(`Resource was not created/updated at ${iri} | ${response.statusText}`);
    console.log(await response.text());
    throw Error(`Failed creating/updating resource at ${iri}`);
  }
  return response;
}

export async function putContainer(iri: string, session: Session): Promise<Response> {
  const response = await session.fetch(iri, {
    method: "PUT",
    headers: {
      "Content-Type": 'text/turtle',
      "Link": `<http://www.w3.org/ns/ldp#Container>; rel="type"`
    },
  });
  if (response.status === 201) {
    logger.debug(`Created Container at ${iri} | status: ${response.status}`);
  } else if (response.status === 205) {
    logger.debug(`Updated Container at ${iri} | status: ${response.status}`);
  } else {
    logger.debug(`Container was not created/updated at ${iri} | ${response.statusText}`);
    console.log(await response.text());
    throw Error(`Failed creating/updating Container at ${iri}`);
  }
  return response;
}

export enum SPARQL {
    INSERT = 'INSERT DATA',
    DELETE = 'DELETE DATA'
}

export async function patchQuads(iri: string, session: Session, quads: Quad[], type: SPARQL): Promise<Response> {
  const writer = new Writer();
  let sparqlQuery = `${type} {`;
  sparqlQuery = sparqlQuery.concat(writer.quadsToString(quads));
  sparqlQuery = sparqlQuery.concat(` 
      }`);
  const response = await session.fetch(iri, {
    method: "PATCH",
    headers: {
      "Content-Type": 'application/sparql-update',
    },
    body: sparqlQuery
  });
  if (response.status === 205) {
    logger.debug(`Updated contents at ${iri} | status: ${response.status}`);
  } else {
    logger.debug(`Resource was not updated at ${iri} | ${response.statusText}`);
    throw Error(`Failed updating resource at ${iri}`);
  }
  return response;
}
