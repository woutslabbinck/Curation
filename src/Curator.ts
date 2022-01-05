/***************************************
 * Title: Curator
 * Description: Contains the class with methods to curate an LDES in LDP, creating a curated LDES in LDP
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@rubensworks/solid-client-authn-isomorphic";
import {extractAnnouncementsMetadata} from "@treecg/ldes-announcements";
import {Announce, DataService, DataSet, View} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {AccessSubject, ACLConfig, LDESConfig, LDESinSolid} from "@treecg/ldes-orchestrator";
import {extractMetadata} from "@treecg/tree-metadata-extraction";
import {Collection, Node, Relation, URI} from "@treecg/tree-metadata-extraction/dist/util/Util";
import {DataFactory, Literal, Quad, Store} from "n3";
import {Logger} from "./logging/Logger";
import {ldjsonToStore, memberToString, storeToString, stringToStore} from "./util/Conversion";
import {
  fetchResourceAsStore,
  patchQuads,
  postResource,
  putContainer,
  putTurtle,
  SPARQL
} from "./util/SolidCommunication";
import {DCAT, DCT, LDP, RDF, TREE, XSD} from "./util/Vocabularies";
import namedNode = DataFactory.namedNode;
import literal = DataFactory.literal;

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

  // this field allows waiting for the synchronization process.

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
     * @param privateCuration When true, the curated LDES in LDP is only visible to the webId from the session. (Default: True)
     * @return {Promise<void>}
     */
  public async init(privateCuration?: boolean): Promise<void> {
    privateCuration = privateCuration !== undefined ? privateCuration : true;
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
      const treeShape = ldesStore.getObjects(null, TREE.shape, null); // NOTE: I don't use this anymore as I manually add a shape in the ldesConfig
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

      if (privateCuration) {
        await this.curatedLDESinSolid.createLDESinLDP(AccessSubject.Agent);
      } else {
        await this.curatedLDESinSolid.createLDESinLDP();
      }
      this.logger.info(`Created curated LDES in Solid at ${this.curatedIRI}`);
    }
  }

  /**
     * Accept a member to the curated LDES.
     * Also removes the iri from the synced Collection
     * @param memberIRI
     * @returns {Promise<Response>}
     */
  public async accept(memberIRI: string): Promise<Response>
  public async accept(memberIRI: string, member: DataSet | DataService | View, timestamp: number): Promise<Response>
  public async accept(memberIRI: string, member?: DataSet | DataService | View, timestamp?: number): Promise<Response> {
    if (!this.curatedLDESinSolid) {
      throw Error("First execute function init() as the curated LDES was not initialised yet");
    }

    if (!timestamp) {
      timestamp = await this.getTimestamp(memberIRI);
    }
    if (!member) {
      const extracted = await this.extractMember(memberIRI);
      member = extracted.value;
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

  /**
     * Curation action reject: Which means that a member is removed from the synced collection
     * @param memberIRI
     * @param timestamp
     * @returns {Promise<Response>}
     */
  public async reject(memberIRI: string, timestamp?: number): Promise<Response> {
    if (!timestamp) {
      timestamp = await this.getTimestamp(memberIRI);
    }
    const response = await this.removeFromSyncedCollection(memberIRI, timestamp);
    return response;
  }

  /**
     * Fetch the timestamp of an IRI by reading the Last-modified header.
     * For a member in an LDES, this will be the same as the creation time (as member are immutable
     * , indicating that they MUST NOT be changed after creation)
     * @param iri IRI of the LDP Resource
     * @returns {Promise<number>}
     */
  private async getTimestamp(iri: string): Promise<number> {
    const response = await this.session.fetch(iri, {
      method: "HEAD"
    });
    const lastModifiedHeader = response.headers.get('Last-modified');
    if (!lastModifiedHeader) throw Error(`Resource ${iri} has no Last-modified header.`);
    const dateLastModified = new Date(lastModifiedHeader);
    return dateLastModified.getTime();
  }


  /**
     * Removes a member from the synced collection stored at the syncedURI
     * @param memberIRI IRI of the member
     * @param timestamp timestamp of creation of the member in the LDES in LDP
     * @returns {Promise<Response>}
     */
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
      // Synced collection exists already
      const body = await response.text();
      const store = await stringToStore(body, {contentType, baseIRI: syncedRootNode});
      await this.otherTimesSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI, store);
    } else {
      // create container
      await putContainer(this.synchronizedIRI, this.session);

      await this.firstTimeSync(LDESRootNode, syncedRootNode, LDESRootCollectionIRI);
    }
  }

  /**
   * Extract the member and its metadata from an LDES in LDP. Also extract the announcement itself
   * Currently, only View, DataSet and DataService can be parsed (interface can be found in LDES-Announcements)
   * @param announcementIRI
   * @returns {Promise<{iri: string, type: string, value: View, announcement: Announce} | {iri: string, type: string, value: DataSet, announcement: Announce} | {iri: string, type: string, value: DataService, announcement: Announce}>}
   */
  public async extractMember(announcementIRI: string): Promise<{ iri: string; type: string; value: View | DataSet | DataService; announcement: Announce }> {
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
      return {type: TREE.Node, value: content, iri: announcementIRI, announcement: announcement};
    }

    if (type.includes(DCAT.Dataset)) {
      this.logger.debug(`DCAT dataset from ${announcementIRI} extracted.`);
      const content = metadata.datasets.get(valueIRI) as DataSet;
      return {type: DCAT.Dataset, value: content, iri: announcementIRI, announcement: announcement};
    }

    if (type.includes(DCAT.DataService)) {
      this.logger.debug(`DCAT Dataservice ${announcementIRI} extracted.`);
      const content = metadata.dataServices.get(valueIRI) as DataService;
      return {type: DCAT.DataService, value: content, iri: announcementIRI, announcement: announcement};
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
    const LDESRootStore = await fetchResourceAsStore(LDESRootNode, this.session);
    const metadata = await extractMetadata(LDESRootStore.getQuads(null, null, null, null));

    const metadataRelations = metadata.nodes.get(LDESRootNode).relation;
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
      const relation: Relation = {...metadata.relations.get(relationIRI['@id'])};
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

    const bodyStore = await ldjsonToStore(JSON.stringify(body));
    const turtleBody = storeToString(bodyStore);
    // place root to syncedURI
    try {
      await putTurtle(syncedRootNode, this.session, turtleBody);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not create root at ${syncedRootNode}`);
    }

    // NOTE: could create this list within metadataRelations.forEAch
    const relationNodeIds: string[] = [];
    LDESRootStore.getObjects(LDESRootNode, TREE.relation, null).forEach(object => {
      const relationNodeId = LDESRootStore.getObjects(object, TREE.node, null)[0].id;
      relationNodeIds.push(relationNodeId);
    });

    for (const relationNodeId of relationNodeIds) {
      await this.synchronizeMembersFromRelation(relationNodeId, LDESRootCollectionIRI);
    }
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


    // update root node and retrieve new relations
    const newRelations = await this.updateRootNode(LDESRootNode, syncedStore, syncedRootNode);

    // synchronize members of new relations
    for (const relation of newRelations) {
      const iri = this.syncedRelationtoLDESRelationIRI(relation);
      await this.synchronizeMembersFromRelation(iri, LDESRootCollectionIRI);
    }

    await this.updateCurrentMostRecentRelation(syncedStore, lastSynced, LDESRootCollectionIRI);

    // update DCTERMS issued time of the synced collection.
    // This way next time the synced collection can be updated properly
    try {
      await patchQuads(syncedRootNode, this.session, [nowQuad], SPARQL.INSERT);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not add new DCTERMS issued at ${syncedRootNode}`);
    }
    try {
      await patchQuads(syncedRootNode, this.session, [syncQuads[0]], SPARQL.DELETE);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not delete old DCTERMS issued at ${syncedRootNode}`);
    }

    this.logger.info(`Sync time updated in Synced root at ${syncedRootNode}`);
  }

  private async updateCurrentMostRecentRelation(syncedStore: Store, lastSynced: number, LDESRootCollectionIRI: string): Promise<void> {
    const syncedMostRecentRelation = this.calculateMostRecentRelation(syncedStore);
    const mostRecentRelation = this.syncedRelationtoLDESRelationIRI(syncedMostRecentRelation);

    const store = await fetchResourceAsStore(mostRecentRelation, this.session);
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

      collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), namedNode(member));
      collection.addQuad(namedNode(member), namedNode(DCT.modified), dateTimeLiteral); // Also add time to curated IRI
    });

    // iri where the part of the collection should be stored
    const collectionIRI = this.ldesRelationToSyncedRelationIRI(mostRecentRelation);
    try {
      await patchQuads(collectionIRI, this.session,
        collection.getQuads(null, null, null, null), SPARQL.INSERT);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not update part of collection at ${collectionIRI}`);
    }
    this.logger.info(`${collectionIRI} was updated with ${collection.getQuads(null, TREE.member, null, null).length} members.`);
  }

  /**
     * Updates the synced root node with the new relations since last sync time.
     * Also returns the new relation nodes which members should be added to the synced collection as well.
     *
     * @param LDESRootNode
     * @param syncedStore
     * @param syncedRootNode
     * @returns {Promise<string[]>}
     */
  private async updateRootNode(LDESRootNode: string, syncedStore: Store, syncedRootNode: string): Promise<string[]> {
    const LDESRootStore = await fetchResourceAsStore(LDESRootNode, this.session);
    const metadata = await extractMetadata(LDESRootStore.getQuads(null, null, null, null));

    const newRelationsStore = new Store();
    const newRelations: string[] = [];

    const metadataRelations = metadata.nodes.get(LDESRootNode).relation;
    metadataRelations.forEach((relationIRI: URI) => {
      const relation: Relation = metadata.relations.get(relationIRI["@id"]);
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
    try {
      await patchQuads(syncedRootNode, this.session,
        newRelationsStore.getQuads(null, null, null, null), SPARQL.INSERT);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not patch root at ${syncedRootNode}`);
    }
    this.logger.info(`Root patched with new relations at ${syncedRootNode}`);
    return newRelations;
  }

  /**
     * Retrieve the URIs of the most recent members of the synced collection.
     * This method can be further optimised as currently the whole collection is fetched even though a part is wanted
     * @param amount number of members that are needed
     * @param startPoint Startpoint in the synced collection
     * @returns {Promise<{timestamp: number, memberIRI: string}[]>} sorted list (newest members first)
     */
  public async getRecentMembers(amount: number, startPoint?: number): Promise<{ timestamp: number, memberIRI: string }[]> {
    // get all member ids
    const syncedRootIRI = `${this.synchronizedIRI}root.ttl`;
    let memberStore: Store;
    try {
      memberStore = await fetchResourceAsStore(syncedRootIRI, this.session);
    } catch (e) {
      this.logger.error('Synchronized root does not exist yet. Call the synchronize() method first before members of the LDES can be retrieved');
      return [];
    }
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
     * Extract the members of a relation node in the LDES in LDP (where the relation node is an LDP Container)
     * And Put all those members together with their created time in the synchronized collection
     * @param iri IRI of an LDP container (which is the relation node)
     * @param LDESCollectionIRI The IRI of the Event Stream (=Collection) of the LDES in LDP
     * @returns {Promise<void>}
     */
  private async synchronizeMembersFromRelation(iri: string, LDESCollectionIRI: string): Promise<void> {
    // get all member URIs and add them as member to collection, then post them to {syncedURI}/timestamp

    const store = await fetchResourceAsStore(iri, this.session);
    const collection = this.extractMembers(store, iri, LDESCollectionIRI);
    const body = storeToString(collection);

    // iri where the part of the collection should be stored
    const collectionIRI = this.ldesRelationToSyncedRelationIRI(iri);
    try {
      await putTurtle(collectionIRI, this.session, body);
    } catch (error) {
      console.log(error);
      this.logger.error(`Could not update part of collection at ${collectionIRI}`);
    }
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

  /**
     * Extract a timestamp (ms) from an RDF Literal
     * @param dateTimeLiteral
     * @returns {number}
     */
  private extractTimeFromLiteral(dateTimeLiteral: Literal): number {
    const value = dateTimeLiteral.value;
    if (!(dateTimeLiteral.datatype && dateTimeLiteral.datatype.id === XSD.dateTime)) {
      throw Error(`Could not interpret ${dateTimeLiteral} as it was not ${XSD.dateTime}`);
    }
    const dateTime = new Date(value);
    return dateTime.getTime();
  }

  /**
     * Convert a timestamp (ms) to an RDF Literal
     * @param timestamp
     * @returns {Literal}
     */
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

  /**
     * Transforms a synchronized relation iri to an ldes relation iri
     * @param iri
     * @returns {string}
     */
  private syncedRelationtoLDESRelationIRI(iri: string): string {
    return `${iri.replace(this.synchronizedIRI, this.ldesIRI)}/`;
  }
}
