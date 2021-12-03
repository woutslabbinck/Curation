/***************************************
 * Title: Curator
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {extractAnnouncementsMetadata, fetchAllAnnouncements} from "@treecg/ldes-announcements";
import {Announce} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {Logger} from "./logging/Logger";
import {LDP} from "./util/Vocabularies";
const parse = require('parse-link-header');

export class Curator {

  private readonly logger = new Logger(this);
  // root of LDES
  private ldesIRI: string;
  private session: Session;
  private curatedIRI: string;

  constructor(ldesIRI: string, session: Session, curatedIRI: string) {
    this.curatedIRI = curatedIRI;
    this.ldesIRI = ldesIRI;
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

  public async accept(announcement:Announce){
    // assume that object is already valid and not the id
    const response = await this.session.fetch(this.curatedIRI,{
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
    if (postResponse.status !== 201){
      this.logger.error(await postResponse.text());
      throw Error('Not succesfull');
    }
    this.logger.info(`Object from announcement located at: ${postResponse.url}`);

  }

}
