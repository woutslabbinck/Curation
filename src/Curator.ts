/***************************************
 * Title: Curator
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {EventStream, LDESClient, newEngine} from '@treecg/actor-init-ldes-client';
import {extractAnnouncementsMetadata, fetchAllAnnouncements} from "@treecg/ldes-announcements";
import {Announce} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {Collection, Node, Relation, URI} from "@treecg/tree-metadata-extraction/dist/util/Util";
import {DataFactory, Literal, Quad, Store} from "n3";
import {Logger} from "./logging/Logger";
import {ldjsonToStore, storeToString} from "./util/Conversion";
import {fetchResourceAsStore, patchQuads, putContainer, putLDJSON, putTurtle, SPARQL} from "./util/SolidCommunication";
import {DCT, LDP, RDF, TREE, XSD} from "./util/Vocabularies";
import namedNode = DataFactory.namedNode;
import literal = DataFactory.literal;


const parse = require('parse-link-header');

export interface CurationConfig {
    ldesIRI: string,
    curatedIRI: string,
    synchronizedIRI: string
}

export class Curator {

  private readonly logger = new Logger(this);
  // root of LDES
  private ldesIRI: string;
  private session: Session;
  private curatedIRI: string;
  private synchronizedIRI: string;

  constructor(config: CurationConfig, session: Session) {
    this.curatedIRI = config.curatedIRI;
    this.ldesIRI = config.ldesIRI;
    this.synchronizedIRI = config.synchronizedIRI;
    this.session = session;
  }

  public async mostRecentAnnouncements(amount: number): Promise<Announce []> {
    this.logger.info("start fetching and extracting announcements");
    // currently very inefficient -> should only extract announcement when asked
    const announcementsStore = await fetchAllAnnouncements(this.ldesIRI);
    const extracted = await extractAnnouncementsMetadata(announcementsStore);
    this.logger.info("announcements are extracted");

    const announcements: Announce[] = [];
    extracted.announcements.forEach(value => {
      const announcement = {...value};
      // TODO: I still have to extract datasets and dataservices
      announcement.object = extracted.views.get(<string>value.object['@id'])!;
      announcements.push(announcement);
    });
    this.logger.info("announcements have view now");
    announcements.sort((first, second) => {
      if (first.object && second.object && 'dct:issued' in first.object && 'dct:issued' in second.object) {
        const firstTimestamp = new Date(first.object["dct:issued"]!["@value"]).getTime();
        const secondTimestamp = new Date(second.object["dct:issued"]!["@value"]).getTime();
        return secondTimestamp - firstTimestamp;
      }
      return 1;
    });
    return announcements.slice(0, amount);
  }

  public async accept(announcement: Announce) {
    // assume that object is already valid and not the id
    const response = await this.session.fetch(this.curatedIRI, {
      method: 'HEAD'
    });


    const linkHeaders = parse(response.headers.get('link'));
    if (!linkHeaders) {
      throw new Error('No Link Header present.');
    }
    const inboxLink = linkHeaders[LDP.inbox];
    if (!inboxLink) {
      throw new Error('No http://www.w3.org/ns/ldp#inbox Link Header present.');
    }

    // Location is the current inbox which can be written to
    const location = `${inboxLink.url}`;

    this.logger.info(`posting announcement to location: ${location}`);

    const postResponse = await this.session.fetch(location, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        Link: '<http://www.w3.org/ns/ldp#Resource>; rel="type"'
      },
      body: JSON.stringify(announcement.object)
    });
    if (postResponse.status !== 201) {
      this.logger.error(await postResponse.text());
      throw Error('Not succesfull');
    }
    this.logger.info(`Object from announcement located at: ${postResponse.url}`);

  }

  public async synchronize() {
    const LDESRootNode = `${this.ldesIRI}root.ttl`;
    const LDESRootCollectionIRI = `${LDESRootNode}#Collection`;
    const syncedRootNode = `${this.synchronizedIRI}root.ttl`;


    const response = await this.session.fetch(syncedRootNode);

    if (response.status === 200) { // todo: replace to (response.status === 200)
      // It exists already
      const body = await response.text();
      const store = await ldjsonToStore(body); // todo: how do i know beforehand its ldjson?
      this.otherTimesSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI, store);
    } else {
      // create container
      await putContainer(this.synchronizedIRI, this.session);

      this.firstTimeSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI);

    }
  }


  private firstTimeSync(LDESRootNode: string, syncedRootNode: string, LDESRootCollectionIRI: string) {
    const options = {
      "pollingInterval": 5000, // millis
      "representation": "Quads", //Object or Quads
      "emitMemberOnce": true,
      "disableSynchronization": true
    };
    const LDESClient: LDESClient = newEngine();
    const eventstreamSync: EventStream = LDESClient.createReadStream(LDESRootNode, options);
    eventstreamSync.on('data', (member) => {
      console.log(member);
    });
    eventstreamSync.on('metadata', ({treeMetadata, url}) => {
      // console.log(treeMetadata);
      // is it a root?
      if (url === LDESRootNode) {
        // First time
        const metadataRelations = treeMetadata.nodes.get(url).relation;

        // create new root body
        const collection: Collection = {
          "@context": {"@vocab": TREE.namespace},
          "@id": `${syncedRootNode}#Collection`,
          "@type": [TREE.Collection],
          view: [{"@id": syncedRootNode}]
        };
        const view: Node = {
          "@context": {"@vocab": TREE.namespace},
          "@id": syncedRootNode,
          "@type": [TREE.Node],
          relation: []
        };
        const now = new Date();
        view[DCT.issued] = {'@value': now.toISOString(), '@type': XSD.dateTime};

        const relations: Relation[] = [];
        metadataRelations.forEach((relationIRI: URI) => {
          // clone the relation -> I don't want to update it
          const relation: Relation = {...treeMetadata.relations.get(relationIRI['@id'])};
          // In practice this if holds always
          if (relation.node && relation.node[0]) {
            // change relation of node -> again clone it otherwise the original node is changed
            relation.node = [...relation.node];
            relation.node[0] = {"@id": relation.node[0]['@id'].replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1)};
          }
          view.relation?.push(relationIRI); // I just defined it, believe me it's there
          relations.push(relation);
        });

        const body = [collection, view, ...relations];

        // place root to syncedURI
        putLDJSON(syncedRootNode, this.session, JSON.stringify(body)).catch(error => {
          console.log(error);
          this.logger.error(`Could not create root at ${syncedRootNode}`);
        });

      } else {
        // get all member URIs and add them as member to collection, then post them to {syncedURI}/timestamp
        fetchResourceAsStore(url, this.session).then(store => {
          const collection = this.extractMembers(store, url, LDESRootCollectionIRI);

          const body = storeToString(collection);
          // iri where the part of the collection should be stored
          const collectionIRI = url.replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1);
          putTurtle(collectionIRI, this.session, body).catch(error => {
            console.log(error);
            this.logger.error(`Could not update part of collection at ${collectionIRI}`);
          });
        });
      }
      // else
      //     {
      //         // get highest value
      //         let largest = {timestamp: 0, url: ''};
      //         treeMetadata['relations'].forEach((element: { value: { [x: string]: any; }[]; node: { [x: string]: any; }[]; }) => {
      //             const datetime = element.value[0]['@value'];
      //             const timestamp = new Date(datetime).getTime();
      //
      //             if (timestamp > largest.timestamp) {
      //                 largest = {
      //                     url: element.node[0]['@id'],
      //                     timestamp: new Date(timestamp).getTime()
      //                 };
      //             }
      //         });
      //     }
    });
    eventstreamSync.on('end', () => {
      this.logger.info("LDESClient finds no more data");
    });
  }

  /**
     * Convert resources in a container of the LDES in LDP to members of the collection and return as a store
     * @param store store of the LDP Container
     * @param iri iri of the LDP Container
     * @param LDESRootCollectionIRI iri of the LDES in LDP EventStream
     * @returns {Store}
     */
  private extractMembers(store: Store, iri: string, LDESRootCollectionIRI: string): Store {
    const members = store.getObjects(null, LDP.contains, null)
      .map((object: any) => namedNode(iri + object.id)); // needed because CSS only gives last part of iri
    const collection = new Store();
    collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(RDF.type), namedNode(TREE.Collection));
    members.forEach((member: any) => {
      collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), member);
    });
    return collection;
  }

  private otherTimesSync(LDESRootNode: string, syncedRootNode: string, LDESRootCollectionIRI: string, syncedStore: Store) {
    const syncQuads = syncedStore.getQuads(syncedRootNode, DCT.issued, null, null);
    if (syncQuads.length !== 1) {
      throw Error(`Can't find last time synced at ${syncedRootNode}.`);
    }
    const lastSynced = this.extractTimeFromLiteral(syncQuads[0].object as Literal);
    const now = new Date();
    const nowQuad = new Quad(namedNode(syncedRootNode), namedNode(DCT.issued), literal(now.toISOString(), namedNode(XSD.dateTime)));

    const newRelations: string[] = [];
    const syncedMostRecentRelation = 'https://tree.linkeddatafragments.org/announcements/1638437905336/'; // todo extract properly
    const options = {
      "pollingInterval": 5000, // millis
      "representation": "Quads", //Object or Quads
      "emitMemberOnce": true,
      "disableSynchronization": true
    };
    const LDESClient: LDESClient = newEngine();
    const eventstreamSync: EventStream = LDESClient.createReadStream(LDESRootNode, options);

    eventstreamSync.on('data', (member) => {
      console.log(member);
    });
    eventstreamSync.on('metadata', ({treeMetadata, url}) => {
      if (url === LDESRootNode) {
        const newRelationsStore = new Store();
        const metadataRelations = treeMetadata.nodes.get(url).relation;
        metadataRelations.forEach((relationIRI: URI) => {
          const relation: Relation = treeMetadata.relations.get(relationIRI["@id"]);
          // They should exist, but still a check?
          if (!(relation.node && relation.node[0] && relation.path && relation.path[0]
                        && relation.value && relation.value[0] && relation["@type"] && relation["@type"][0])) {
            throw Error('relation parts are not in this relation');
          }
          let node: Node = {...relation.node[0]};
          node = {"@id": node['@id'].replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1)};
          const exists = syncedStore.getQuads(null, TREE.node, node["@id"], null).length === 1;

          // only if it doesn't exist yet, should the root be patched
          if (!exists) {
            const relationNode = newRelationsStore.createBlankNode();
            newRelationsStore.addQuad(namedNode(syncedRootNode), namedNode(TREE.relation), relationNode);

            newRelationsStore.addQuad(relationNode, namedNode(RDF.type), namedNode(relation["@type"][0]));
            newRelationsStore.addQuad(relationNode, namedNode(TREE.node), namedNode(node["@id"]));
            newRelationsStore.addQuad(relationNode, namedNode(TREE.path), namedNode(relation.path[0]["@id"]));
            newRelationsStore.addQuad(relationNode, namedNode(TREE.value), literal(relation.value[0]['@value'], namedNode(XSD.dateTime)));

            newRelations.push(node["@id"]);
          }
        });

        patchQuads(syncedRootNode, this.session,
          newRelationsStore.getQuads(null, null, null, null), SPARQL.INSERT)
          .catch(error => {
            console.log(error);
            this.logger.error(`Could not patch root at ${syncedRootNode}`);
          });
        this.logger.info(`Root patched with new relations at ${syncedRootNode}`);

      } else {
        // if relation is new, do same as first time
        if (newRelations.includes(url)) {
          fetchResourceAsStore(url, this.session).then(store => {
            const collection = this.extractMembers(store, url, LDESRootCollectionIRI);

            const body = storeToString(collection);
            // iri where the part of the collection should be stored
            const collectionIRI = url.replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1);
            putTurtle(collectionIRI, this.session, body).catch(error => {
              console.log(error);
              this.logger.error(`Could not update part of collection at ${collectionIRI}`);
            });
          });
        } else if (url === syncedMostRecentRelation) {
          fetchResourceAsStore(url, this.session).then(store => {
            const potentialMembers = store.getObjects(null, LDP.contains, null).map(object => object.id);
            const members: string[] = [];
            potentialMembers.forEach(memberID => {
              const memberTimeLiteral = store.getQuads(memberID, DCT.modified, null, null)[0].object;
              const memberDateTime = this.extractTimeFromLiteral(memberTimeLiteral as Literal);
              if (memberDateTime > lastSynced) {
                members.push(memberID);
                console.log(memberID);
              }

            });
            const collection = new Store();
            collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(RDF.type), namedNode(TREE.Collection));
            members.forEach((member: string) => {
              collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), namedNode(url + member)); // url has to be added
            });

            // iri where the part of the collection should be stored
            const collectionIRI = url.replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1);
            patchQuads(collectionIRI, this.session,
              collection.getQuads(null, null, null, null), SPARQL.INSERT).catch(error => {
              console.log(error);
              this.logger.error(`Could not update part of collection at ${collectionIRI}`);
            });
            this.logger.info(`${collectionIRI} was updated with ${  collection.getQuads(null, null, null, null).length -1} members.`);
          });
        }
      }

    });
    eventstreamSync.on('end', () => {
      this.logger.info("LDESClient finds no more data");
      patchQuads(syncedRootNode, this.session, [nowQuad], SPARQL.INSERT)
        .catch(error => {
          console.log(error);
          this.logger.error(`Could not add new DCTERMS issued at ${syncedRootNode}`);
        });
      patchQuads(syncedRootNode, this.session, [syncQuads[0]], SPARQL.DELETE)
        .catch(error => {
          console.log(error);
          this.logger.error(`Could not delete old DCTERMS issued at ${syncedRootNode}`);
        });
      this.logger.info(`Sync time updated in Synced root at ${syncedRootNode}`);
    });
  }

  private extractTimeFromLiteral(dateTimeLiteral: Literal): number {
    const value = dateTimeLiteral.value;
    if (!(dateTimeLiteral.datatype && dateTimeLiteral.datatype.id === XSD.dateTime)) {
      throw Error(`Could not interpret ${dateTimeLiteral} as it was not ${XSD.dateTime}`);
    }
    const dateTime = new Date(value);
    return dateTime.getTime();
  }

}
