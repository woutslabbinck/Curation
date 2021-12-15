/***************************************
 * Title: Curator
 * Description: Contains the class with methods to curate an LDES in LDP, creating a curated LDES in LDP
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {EventStream, LDESClient, newEngine} from '@treecg/actor-init-ldes-client';
import {extractAnnouncementsMetadata} from "@treecg/ldes-announcements";
import {DataService, DataSet, View} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {extractMetadata} from "@treecg/tree-metadata-extraction";
import {Collection, Node, Relation, URI} from "@treecg/tree-metadata-extraction/dist/util/Util";
import {DataFactory, Literal, Quad, Store} from "n3";
import {ACLConfig, LDESConfig, LDESinSolid, AccessSubject} from '../../LDES-Orchestrator'; // todo: make package and do real import
import {Logger} from "./logging/Logger";
import {memberToString, storeToString, stringToStore} from "./util/Conversion";
import {
  fetchResourceAsStore,
  patchQuads,
  postResource,
  putContainer,
  putLDJSON,
  putTurtle,
  SPARQL
} from "./util/SolidCommunication";
import {DCAT, DCT, LDP, RDF, TREE, XSD} from "./util/Vocabularies";
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
  private curatedLDESinSolid: LDESinSolid | undefined;

  constructor(config: CurationConfig, session: Session) {
    this.curatedIRI = config.curatedIRI;
    this.ldesIRI = config.ldesIRI;
    this.synchronizedIRI = config.synchronizedIRI;
    this.session = session;
  }

  /**
     * Checks whether the user is logged in
     * Load the curatedLDES in Solid
     * Creates the curatedLDES in Solid if it does not exist (requires certain access control permissions on the curated IRI)
     * Furthermore verifies that the LDES exists as well.
     * @returns {Promise<void>}
     */
  public async init(): Promise<void> {
    if (!this.session.info.isLoggedIn) {
      this.logger.error(`Contents of the session: ${JSON.stringify(this.session.info)}`);
      throw Error("Session is not logged in");
    }

    let config: { ldesConfig: LDESConfig, aclConfig: ACLConfig } | undefined = undefined;
    try {
      config = await LDESinSolid.getConfig(this.curatedIRI, this.session);
    } catch (e) {
      this.logger.info(`No curated LDES in LDP exist yet at ${this.curatedIRI}`);
    }

    let ldesStore: Store;
    try {
      ldesStore = await fetchResourceAsStore(`${this.ldesIRI}root.ttl`, this.session);
    } catch (e) {
      this.logger.error(`LDES in LDP does not exist at ${this.ldesIRI}`);
      throw Error("LDES in LDP does not exist");
    }

    if (config) {
      this.curatedLDESinSolid = new LDESinSolid(config.ldesConfig, config.aclConfig, this.session);
    } else {
      const treeShape = ldesStore.getObjects(null, TREE.shape, null); // TODO: what shape should the curated set have? -> Currently this will make it fail as I manually have to remove the shape
      const relations = ldesStore.getObjects(null, TREE.relation, null);

      if (relations.length === 0) {
        throw Error('Original LDES root node currently no relations.');
      }

      if (treeShape.length === 0) {
        throw Error('Original LDES has currently no shape.');
      }
      const bn = relations[0].id;
      const relationType = ldesStore.getObjects(bn, RDF.type, null);
      const treePath = ldesStore.getObjects(null, TREE.path, null);

      config = {
        aclConfig: {
          agent: this.session.info.webId! // I know it exists
        },
        ldesConfig: {
          base: this.curatedIRI,
          treePath: treePath[0].id,
          shape: 'https://tree.linkeddatafragments.org/datasets/shape',// TODO: add this shape to config?
          relationType: relationType[0].id,
        }
      };
      this.curatedLDESinSolid = new LDESinSolid(config.ldesConfig, config.aclConfig, this.session);
      await this.curatedLDESinSolid.createLDESinLDP(AccessSubject.Agent); // note: Currently creates private curated LDES in Solid

      this.logger.info(`Created curated LDES in Solid at ${this.curatedIRI}`);
    }
  }

  /**
     * TODO fix parameters -> make it possible to only give iri
     * @param member
     * @param memberIRI
     * @param timestamp
     * @returns {Promise<Response>}
     */
  public async accept(member: DataSet | DataService | View, memberIRI: string, timestamp: number): Promise<Response> {
    if (!this.curatedLDESinSolid) {
      throw Error("First execute function init() as the curated LDES was not initialised yet");
    }
    const containerIRI = await this.curatedLDESinSolid.getCurrentContainer();
    this.logger.debug(`Posting contents of ${member["@id"]} to ${containerIRI}.`);

    const text = await memberToString(member, memberIRI);
    try {
      this.logger.info(`Accepted ${memberIRI} to the curated ldes located at ${this.curatedIRI}`);
      const response = await postResource(containerIRI, this.session, text, 'text/turtle');

      await this.removeFromSyncedCollection(memberIRI, timestamp);
      return response;

    } catch (e) {
      this.logger.error('Something failed');
      console.log(e);
      throw Error(`Could not add the member to ${this.curatedIRI}`);
    }
  }

  public async reject(memberIRI: string, timestamp: number): Promise<Response> {
    const response = await this.removeFromSyncedCollection(memberIRI, timestamp);
    return response;
  }


  private async removeFromSyncedCollection(memberIRI: string, timestamp: number): Promise<Response> {
    const syncedLocation = memberIRI.replace(this.ldesIRI, this.synchronizedIRI).split('/').slice(0, -1).join('/'); // NOTE: maybe better to follow the relations? not speed wise but logic wise
    const memberQuad = new Quad(namedNode(`${this.ldesIRI}root.ttl#Collection`), namedNode(TREE.member), namedNode(memberIRI));
    const timeQuad = new Quad(namedNode(memberIRI), namedNode(DCT.modified), this.timestampToLiteral(timestamp));
    const response = await patchQuads(syncedLocation, this.session, [memberQuad, timeQuad], SPARQL.DELETE);
    this.logger.info(`Removed ${memberIRI} from the synced collection at ${this.synchronizedIRI}`);

    return response;
  }

  /**
     * Synchronize the Synced collection with the LDES in LDP
     *
     * The synced collection is a TREE collection with as members the URIs of the LDES in LDP. Each member also has a timestamp.
     * A synchronize operations looks at the last synced time and adds all members which were added to the LDES to the synced collection.
     *
     * @returns {Promise<void>}
     */
  public async synchronize(): Promise<void> {
    const LDESRootNode = `${this.ldesIRI}root.ttl`;
    const LDESRootCollectionIRI = `${LDESRootNode}#Collection`;
    const syncedRootNode = `${this.synchronizedIRI}root.ttl`;


    const response = await this.session.fetch(syncedRootNode);

    const contentType = response.headers.get('content-type');
    if (!contentType) {
      throw Error(`No content-type known of ${syncedRootNode}`);
    }

    if (response.status === 200) {
      // It exists already
      const body = await response.text();
      const store = await stringToStore(body, {contentType});
      await this.otherTimesSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI, store);
    } else {
      // create container
      await putContainer(this.synchronizedIRI, this.session);

      await this.firstTimeSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI);

    }
  }

  /**
     * Extract the member and its metadata from an LDES in LDP.
     * Currently, only View, DataSet and DataService can be parsed (interface can be found in LDES-Announcements)
     * @param announcementIRI
     * @returns {Promise<{iri: string, type: string, value: View} | {iri: string, type: string, value: DataSet} | {iri: string, type: string, value: DataService}>}
     */
  public async extractMember(announcementIRI: string): Promise<{ value: View | DataService | DataSet, type: string, iri: string }> {
    const memberStore = await fetchResourceAsStore(announcementIRI, this.session);
    const metadata = await extractAnnouncementsMetadata(memberStore);
    const announcementIRIs: string[] = [];

    metadata.announcements.forEach(announcement => {
      announcementIRIs.push(announcement["@id"]);
    });
    if (announcementIRIs.length !== 1) {
      throw Error(`There is more than one announcement in ${announcementIRI}`);
    }
    const iri = announcementIRIs[0];
    const announcement = metadata.announcements.get(iri);
    if (!announcement) throw Error(`Announcement was not correct ${iri}`);

    const valueIRI = announcement.object["@id"];
    const type = memberStore.getObjects(valueIRI, RDF.type, null).map(object => object.id);

    if (type.includes(TREE.Node)) {
      this.logger.debug(`View from ${announcementIRI} extracted.`);
      const content = metadata.views.get(valueIRI) as View;
      return {type: TREE.Node, value: content, iri: announcementIRI};
    }

    if (type.includes(DCAT.Dataset)) {
      this.logger.debug(`DCAT dataset from ${announcementIRI} extracted.`);
      const content = metadata.datasets.get(valueIRI) as DataSet;
      return {type: DCAT.Dataset, value: content, iri: announcementIRI};
    }

    if (type.includes(DCAT.DataService)) {
      this.logger.debug(`DCAT Dataservice ${announcementIRI} extracted.`);
      const content = metadata.dataServices.get(valueIRI) as DataService;
      return {type: DCAT.DataService, value: content, iri: announcementIRI};
    }
    throw Error(`Could not extract member from ${announcementIRI}`);
  }

  /**
     * Flow for the first time an LDES in LDP has to be synchronized
     *
     * @param LDESRootNode IRI of the LDES in LDP root node
     * @param syncedRootNode IRI of the root node of the synced collection
     * @param LDESRootCollectionIRI IRI of the LDES in LDP collection
     */
  private async firstTimeSync(LDESRootNode: string, syncedRootNode: string, LDESRootCollectionIRI: string): Promise<void> {
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
            relation.node[0] = {
              "@id": this.ldesRelationToSyncedRelationIRI(relation.node[0]['@id'])
            }
            ;
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
        this.synchronizeMembersFromRelation(url, LDESRootCollectionIRI);
      }
    });
    eventstreamSync.on('end', () => {
      this.logger.info("LDESClient finds no more data");
      return;
    });
  }

  /**
     * Retrieve the URIs of the most recent members of the synced collection.
     * @param amount number of members that are needed
     * @param startPoint Startpoint in the synced collection
     * @returns {Promise<{timestamp: number, memberIRI: string}[]>} sorted list (newest members first)
     */
  public async getRecentMembers(amount: number, startPoint?: number): Promise<{ timestamp: number, memberIRI: string }[]> {
    // get all member ids
    const syncedRootIRI = `${this.synchronizedIRI}root.ttl`;
    const memberStore = await fetchResourceAsStore(syncedRootIRI, this.session);
    const syncedMetadata = await extractMetadata(memberStore.getQuads(null, null, null, null));
    const relationIRIs: string[] = [];
    syncedMetadata.relations.forEach(relation => relationIRIs.push(relation.node[0]["@id"]));

    const promiseStores: Promise<Store>[] = [];
    for (const iri of relationIRIs) {
      promiseStores.push(fetchResourceAsStore(iri, this.session));
    }
    await Promise.all(promiseStores).then((stores: Store[]): void => {
      stores.forEach(store => {
        memberStore.addQuads(store.getQuads(null, null, null, null));
      });
    });

    const timeSortedMembers: { timestamp: number, memberIRI: string }[] = [];
    memberStore.getQuads(`${this.ldesIRI}root.ttl#Collection`, TREE.member, null, null).forEach(member => {
      const memberIRI = member.object.id;
      const timeliteral = memberStore.getObjects(memberIRI, DCT.modified, null)[0] as Literal;
      timeSortedMembers.push({
        timestamp: this.extractTimeFromLiteral(timeliteral),
        memberIRI
      });
    });
    this.logger.info(`Members extracted from ${syncedRootIRI}`);

    // sort them
    timeSortedMembers.sort((first, second) =>
      second.timestamp - first.timestamp);

    // extract the ones asked in the function and return them
    return timeSortedMembers.slice(startPoint, amount);
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
      .map((object: any) => object.id);

    const collection = new Store();
    collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(RDF.type), namedNode(TREE.Collection));
    members.forEach((member: any) => {
      const dateTimeLiteral = store.getObjects(member, DCT.modified, null)[0];

      if (!dateTimeLiteral) throw Error(`Announcement has no dc:modified ${iri}${member}`);
      collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), namedNode(member));
      collection.addQuad(namedNode(member), namedNode(DCT.modified), dateTimeLiteral); // Also add time to curated IRI
    });
    return collection;
  }

  /**
     * Flow for the subsequent times an LDES in LDP has to be synchronized
     *
     * @param LDESRootNode IRI of the LDES in LDP root node
     * @param syncedRootNode IRI of the root node of the synced collection
     * @param LDESRootCollectionIRI IRI of the LDES in LDP collection
     * @param syncedStore The store of the synced root node
     */
  private async otherTimesSync(LDESRootNode: string, syncedRootNode: string, LDESRootCollectionIRI: string, syncedStore: Store): Promise<void> {
    const syncQuads = syncedStore.getQuads(syncedRootNode, DCT.issued, null, null);
    if (syncQuads.length !== 1) {
      throw Error(`Can't find last time synced at ${syncedRootNode}.`);
    }
    const lastSynced = this.extractTimeFromLiteral(syncQuads[0].object as Literal);
    const nowQuad = new Quad(namedNode(syncedRootNode), namedNode(DCT.issued), this.timestampToLiteral(Date.now()));

    const newRelations: string[] = [];
    const syncedMostRecentRelation = this.calculateMostRecentRelation(syncedStore);
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
      const syncTranslation = this.ldesRelationToSyncedRelationIRI(url);

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
          node = {
            "@id": this.ldesRelationToSyncedRelationIRI(node['@id'])
          }
          ;
          const exists = syncedStore.getQuads(null, TREE.node, node["@id"], null).length === 1;

          // only if it doesn't exist yet, should the root be patched
          if (!exists) {
            const relationNode = newRelationsStore.createBlankNode();
            newRelationsStore.addQuad(namedNode(syncedRootNode), namedNode(TREE.relation), relationNode);

            newRelationsStore.addQuad(relationNode, namedNode(RDF.type), namedNode(relation["@type"][0]));
            newRelationsStore.addQuad(relationNode, namedNode(TREE.node), namedNode(node["@id"]));
            newRelationsStore.addQuad(relationNode, namedNode(TREE.path), namedNode(relation.path[0]["@id"]));
            const dateTime = new Date(relation.value[0]['@value']);
            newRelationsStore.addQuad(relationNode, namedNode(TREE.value), this.timestampToLiteral(dateTime.getTime()));

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
        if (newRelations.includes(syncTranslation)) {
          this.synchronizeMembersFromRelation(url, LDESRootCollectionIRI);
        } else if (syncTranslation === syncedMostRecentRelation) {
          // current url is the most recent relation -> Only add the most recent members
          fetchResourceAsStore(url, this.session).then(store => {
            const potentialMembers = store.getObjects(null, LDP.contains, null).map(object => object.id);
            const members: string[] = [];
            potentialMembers.forEach(memberID => {
              const memberTimeLiteral = store.getQuads(memberID, DCT.modified, null, null)[0].object;
              const memberDateTime = this.extractTimeFromLiteral(memberTimeLiteral as Literal);
              if (memberDateTime > lastSynced) {
                members.push(memberID);
              }

            });
            const collection = new Store();
            collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(RDF.type), namedNode(TREE.Collection));
            members.forEach((member: string) => {
              const dateTimeLiteral = store.getObjects(member, DCT.modified, null)[0];
              if (!dateTimeLiteral) throw Error(`Announcement has no dc:modified ${member}`);

              collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), namedNode( member));
              collection.addQuad(namedNode(member), namedNode(DCT.modified), dateTimeLiteral); // Also add time to curated IRI
            });

            // iri where the part of the collection should be stored
            const collectionIRI = this.ldesRelationToSyncedRelationIRI(url);
            patchQuads(collectionIRI, this.session,
              collection.getQuads(null, null, null, null), SPARQL.INSERT).catch(error => {
              console.log(error);
              this.logger.error(`Could not update part of collection at ${collectionIRI}`);
            });
            this.logger.info(`${collectionIRI} was updated with ${collection.getQuads(null, TREE.member, null, null).length} members.`);
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
      return;
    });
  }

  private async synchronizeMembersFromRelation(iri: string, LDESRootCollectionIRI: string): Promise<void> {
    // get all member URIs and add them as member to collection, then post them to {syncedURI}/timestamp

    const store = await fetchResourceAsStore(iri, this.session);
    const collection = this.extractMembers(store, iri, LDESRootCollectionIRI);
    const body = storeToString(collection);

    // iri where the part of the collection should be stored
    const collectionIRI = this.ldesRelationToSyncedRelationIRI(iri);
    putTurtle(collectionIRI, this.session, body).catch(error => {
      console.log(error);
      this.logger.error(`Could not update part of collection at ${collectionIRI}`);
    });
  }

  /**
     * Using a store containing several relations, calculate the most recent relation
     * @param syncedStore
     * @returns {any}
     */
  private calculateMostRecentRelation(syncedStore: Store): string {
    const relationValues = syncedStore.getQuads(null, TREE.value, null, null);
    let maxValue = 0;
    const relationMap: Map<number, string> = new Map();
    relationValues.forEach(quad => {
      const time = this.extractTimeFromLiteral(quad.object as Literal);
      if (time >= maxValue) {
        maxValue = time;
      }
      const nodeId = syncedStore.getQuads(quad.subject, TREE.node, null, null)[0].object.id;
      relationMap.set(time, nodeId);
    });
    const mostRecentRelation = relationMap.get(maxValue);
    if (!mostRecentRelation) {
      throw Error('not possible');
    }
    return mostRecentRelation;
  }

  private extractTimeFromLiteral(dateTimeLiteral: Literal): number {
    const value = dateTimeLiteral.value;
    if (!(dateTimeLiteral.datatype && dateTimeLiteral.datatype.id === XSD.dateTime)) {
      throw Error(`Could not interpret ${dateTimeLiteral} as it was not ${XSD.dateTime}`);
    }
    const dateTime = new Date(value);
    return dateTime.getTime();
  }

  private timestampToLiteral(timestamp: number): Literal {
    const dateTime = new Date(timestamp);
    return literal(dateTime.toISOString(), namedNode(XSD.dateTime));
  }

  /**
     * Transforms an ldes relation iri to a synchronized relation iri
     * E.g. ldesIRI is "https://tree.linkeddatafragments.org/announcements/"
     * and synchronizedIRI is "https://tree.linkeddatafragments.org/datasets/synced/"
     * Then "https://tree.linkeddatafragments.org/announcements/1636985640000/" becomes
     * "https://tree.linkeddatafragments.org/datasets/synced/1636985640000"
     * @param iri
     * @returns {string}
     */
  private ldesRelationToSyncedRelationIRI(iri: string): string {
    return iri.replace(this.ldesIRI, this.synchronizedIRI).slice(0, -1);
  }
}
