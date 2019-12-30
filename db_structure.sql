# ************************************************************
# Sequel Pro SQL dump
# Version 4541
#
# http://www.sequelpro.com/
# https://github.com/sequelpro/sequelpro
#
# Host: localhost (MySQL 5.7.27)
# Database: ToadReader
# Generation Time: 2019-12-30 09:40:16 +0000
# ************************************************************


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;


# Dump of table book
# ------------------------------------------------------------

CREATE TABLE `book` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `title` text CHARACTER SET utf8mb4 NOT NULL,
  `author` text CHARACTER SET utf8mb4 NOT NULL,
  `isbn` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `coverHref` text CHARACTER SET utf8mb4,
  `rootUrl` varchar(100) CHARACTER SET utf8mb4 DEFAULT '',
  `updated_at` datetime NOT NULL ON UPDATE CURRENT_TIMESTAMP,
  `standardPriceInCents` int(11) DEFAULT NULL,
  `epubSizeInMB` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `rootUrl` (`rootUrl`),
  KEY `isbn` (`isbn`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin;



# Dump of table book_instance
# ------------------------------------------------------------

CREATE TABLE `book_instance` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `idp_id` int(11) NOT NULL,
  `book_id` int(11) unsigned NOT NULL,
  `user_id` int(11) NOT NULL,
  `first_given_access_at` datetime NOT NULL,
  `version` enum('BASE','ENHANCED','PUBLISHER','INSTRUCTOR') CHARACTER SET utf8mb4 NOT NULL DEFAULT 'BASE',
  `expires_at` datetime DEFAULT NULL,
  `enhanced_tools_expire_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idp_id` (`idp_id`,`user_id`,`book_id`),
  KEY `idp_id_2` (`idp_id`),
  KEY `book_id` (`book_id`),
  KEY `user_id` (`user_id`),
  KEY `first_given_access_at` (`first_given_access_at`),
  KEY `version` (`version`),
  KEY `expires_at` (`expires_at`),
  KEY `enhanced_tools_expire_at` (`enhanced_tools_expire_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table book-idp
# ------------------------------------------------------------

CREATE TABLE `book-idp` (
  `book_id` int(11) unsigned NOT NULL,
  `idp_id` int(11) unsigned NOT NULL,
  `link_href` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `link_label` text CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (`book_id`,`idp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin;



# Dump of table classroom
# ------------------------------------------------------------

CREATE TABLE `classroom` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `idp_id` int(11) unsigned NOT NULL,
  `book_id` int(11) unsigned NOT NULL,
  `name` varchar(255) NOT NULL DEFAULT '',
  `access_code` varchar(10) DEFAULT NULL,
  `instructor_access_code` varchar(10) DEFAULT NULL,
  `syllabus` text,
  `introduction` text,
  `classroom_highlights_mode` enum('OFF','CLASSROOM','GROUP') NOT NULL DEFAULT 'CLASSROOM',
  `closes_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`uid`),
  UNIQUE KEY `access_code` (`access_code`),
  UNIQUE KEY `instructor_access_code` (`instructor_access_code`),
  KEY `idp_id` (`idp_id`),
  KEY `book_id` (`book_id`),
  KEY `classroom_highlights_mode` (`classroom_highlights_mode`),
  KEY `closes_at` (`closes_at`),
  KEY `created_at` (`created_at`),
  KEY `updated_at` (`updated_at`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table classroom_group
# ------------------------------------------------------------

CREATE TABLE `classroom_group` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `classroom_uid` varchar(36) NOT NULL DEFAULT '',
  `name` varchar(255) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`uid`),
  KEY `classroom_id` (`classroom_uid`),
  KEY `name` (`name`),
  KEY `created_at` (`created_at`),
  KEY `updated_at` (`updated_at`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table classroom_member
# ------------------------------------------------------------

CREATE TABLE `classroom_member` (
  `classroom_uid` varchar(36) NOT NULL DEFAULT '',
  `user_id` int(11) unsigned NOT NULL,
  `classroom_group_uid` varchar(36) DEFAULT NULL,
  `role` enum('STUDENT','INSTRUCTOR') NOT NULL DEFAULT 'STUDENT',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`classroom_uid`,`user_id`),
  KEY `classroom_id` (`classroom_uid`),
  KEY `user_id` (`user_id`),
  KEY `classroom_group_id` (`classroom_group_uid`),
  KEY `role` (`role`),
  KEY `created_at` (`created_at`),
  KEY `updated_at` (`updated_at`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table classroom_schedule_date
# ------------------------------------------------------------

CREATE TABLE `classroom_schedule_date` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `classroom_uid` varchar(36) NOT NULL DEFAULT '',
  `due_at` datetime NOT NULL,
  `label` varchar(255) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`uid`),
  KEY `classroom_id` (`classroom_uid`),
  KEY `due_at` (`due_at`),
  KEY `label` (`label`),
  KEY `created_at` (`created_at`),
  KEY `updated_at` (`updated_at`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table classroom_schedule_date_item
# ------------------------------------------------------------

CREATE TABLE `classroom_schedule_date_item` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `classroom_schedule_date_uid` varchar(36) NOT NULL DEFAULT '',
  `spineIdRef` varchar(255) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`uid`),
  KEY `classroom_schedule_date_id` (`classroom_schedule_date_uid`),
  KEY `spineIdRef` (`spineIdRef`),
  KEY `created_at` (`created_at`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table computed_book_access
# ------------------------------------------------------------

CREATE TABLE `computed_book_access` (
  `idp_id` int(11) NOT NULL,
  `book_id` int(11) unsigned NOT NULL,
  `user_id` int(11) NOT NULL,
  `version` enum('BASE','ENHANCED','PUBLISHER','INSTRUCTOR') CHARACTER SET utf8mb4 NOT NULL DEFAULT 'BASE',
  `expires_at` datetime DEFAULT NULL,
  `enhanced_tools_expire_at` datetime DEFAULT NULL,
  UNIQUE KEY `idp_id` (`idp_id`,`user_id`,`book_id`),
  KEY `idp_id_2` (`idp_id`),
  KEY `book_id` (`book_id`),
  KEY `user_id` (`user_id`),
  KEY `version` (`version`),
  KEY `expires_at` (`expires_at`),
  KEY `enhanced_tools_expire_at` (`enhanced_tools_expire_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table embed_website
# ------------------------------------------------------------

CREATE TABLE `embed_website` (
  `domain` varchar(253) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `idp_id` int(11) unsigned NOT NULL,
  PRIMARY KEY (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table highlight
# ------------------------------------------------------------

CREATE TABLE `highlight` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT COMMENT 'Only used for instructor_highlight to attach to.',
  `user_id` int(11) NOT NULL,
  `book_id` int(11) unsigned NOT NULL,
  `spineIdRef` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `cfi` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `color` tinyint(3) unsigned NOT NULL,
  `note` text CHARACTER SET utf8mb4 NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `deleted_at` datetime NOT NULL DEFAULT '0000-01-01 00:00:00',
  PRIMARY KEY (`user_id`,`book_id`,`spineIdRef`,`cfi`,`deleted_at`),
  UNIQUE KEY `id` (`id`),
  KEY `user_id` (`user_id`,`book_id`),
  KEY `deleted_at` (`deleted_at`),
  KEY `updated_at` (`updated_at`),
  KEY `user_id_2` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin;



# Dump of table idp
# ------------------------------------------------------------

CREATE TABLE `idp` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8_bin NOT NULL,
  `domain` varchar(253) COLLATE utf8_bin NOT NULL DEFAULT '',
  `useReaderTxt` tinyint(4) NOT NULL,
  `sessionSharingAsRecipientInfo` text COLLATE utf8_bin,
  `entryPoint` text COLLATE utf8_bin,
  `logoutUrl` text COLLATE utf8_bin,
  `nameQualifier` varchar(100) COLLATE utf8_bin DEFAULT '',
  `idpcert` text COLLATE utf8_bin,
  `spcert` text COLLATE utf8_bin,
  `spkey` text COLLATE utf8_bin,
  `internalJWT` text COLLATE utf8_bin,
  `userInfoEndpoint` varchar(255) COLLATE utf8_bin DEFAULT '',
  `userInfoJWT` text COLLATE utf8_bin,
  `androidAppURL` text COLLATE utf8_bin,
  `iosAppURL` text COLLATE utf8_bin,
  `xapiOn` tinyint(1) NOT NULL DEFAULT '0',
  `xapiEndpoint` text COLLATE utf8_bin,
  `xapiUsername` text COLLATE utf8_bin,
  `xapiPassword` text COLLATE utf8_bin,
  `xapiMaxBatchSize` int(11) DEFAULT NULL,
  `xapiConsentText` text COLLATE utf8_bin,
  `googleAnalyticsCode` text COLLATE utf8_bin,
  `language` varchar(5) COLLATE utf8_bin DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `demo_expires_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `domain` (`domain`),
  KEY `nameQualifier` (`nameQualifier`),
  KEY `demo_expires_at` (`demo_expires_at`),
  KEY `xapiOn` (`xapiOn`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin;



# Dump of table idp_group_member
# ------------------------------------------------------------

CREATE TABLE `idp_group_member` (
  `idp_id` int(11) NOT NULL,
  `idp_group_id` int(11) NOT NULL,
  PRIMARY KEY (`idp_id`,`idp_group_id`),
  KEY `idp_id` (`idp_id`),
  KEY `idp_group_id` (`idp_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table instructor_highlight
# ------------------------------------------------------------

CREATE TABLE `instructor_highlight` (
  `highlight_id` int(11) unsigned NOT NULL,
  `classroom_uid` varchar(36) NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`highlight_id`,`classroom_uid`),
  KEY `highlight_id` (`highlight_id`),
  KEY `classroom_id` (`classroom_uid`),
  KEY `created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table latest_location
# ------------------------------------------------------------

CREATE TABLE `latest_location` (
  `user_id` int(11) NOT NULL,
  `book_id` int(11) unsigned NOT NULL,
  `cfi` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`user_id`,`book_id`),
  KEY `user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_bin;



# Dump of table subscription
# ------------------------------------------------------------

CREATE TABLE `subscription` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `idp_id` int(11) NOT NULL,
  `label` text NOT NULL,
  `deleted_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idp_id` (`idp_id`),
  KEY `deleted_at` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table subscription_instance
# ------------------------------------------------------------

CREATE TABLE `subscription_instance` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `subscription_id` int(11) unsigned NOT NULL,
  `user_id` int(11) NOT NULL,
  `first_given_access_at` datetime NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `enhanced_tools_expire_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `subscription_id` (`subscription_id`,`user_id`),
  KEY `user_id` (`user_id`),
  KEY `first_given_access_at` (`first_given_access_at`),
  KEY `expires_at` (`expires_at`),
  KEY `enhanced_tools_expire_at` (`enhanced_tools_expire_at`),
  KEY `subscription_id_2` (`subscription_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table subscription-book
# ------------------------------------------------------------

CREATE TABLE `subscription-book` (
  `subscription_id` int(11) NOT NULL COMMENT 'When negative, this row represents a free book, automatically given to all users with the negated idp_id.',
  `book_id` int(11) unsigned NOT NULL,
  `version` enum('BASE','ENHANCED','PUBLISHER','INSTRUCTOR') CHARACTER SET utf8mb4 NOT NULL DEFAULT 'BASE',
  PRIMARY KEY (`subscription_id`,`book_id`),
  KEY `subscription_id` (`subscription_id`),
  KEY `book_id` (`book_id`),
  KEY `version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;



# Dump of table tool
# ------------------------------------------------------------

CREATE TABLE `tool` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `classroom_uid` varchar(36) NOT NULL DEFAULT '',
  `classroom_group_uid` varchar(36) DEFAULT NULL,
  `spineIdRef` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  `cfi` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `ordering` int(11) unsigned NOT NULL,
  `name` varchar(255) NOT NULL DEFAULT '',
  `toolType` enum('QUIZ','NOTES_INSERT','LTI','VIDEO','DISCUSSION_QUESTION','REFLECTION_QUESTION','POLL','DOCUMENT','IMAGES','AUDIO') NOT NULL DEFAULT 'NOTES_INSERT',
  `data` text NOT NULL,
  `undo_array` text NOT NULL,
  `due_at` datetime DEFAULT NULL,
  `closes_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `published_at` datetime DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `currently_published_tool_id` int(10) unsigned DEFAULT NULL,
  PRIMARY KEY (`uid`),
  KEY `classroom_id` (`classroom_uid`),
  KEY `classroom_group_id` (`classroom_group_uid`),
  KEY `spineIdRef` (`spineIdRef`),
  KEY `cfi` (`cfi`),
  KEY `name` (`name`),
  KEY `type` (`toolType`),
  KEY `due_at` (`due_at`),
  KEY `closes_at` (`closes_at`),
  KEY `created_at` (`created_at`),
  KEY `updated_at` (`updated_at`),
  KEY `published_at` (`published_at`),
  KEY `deleted_at` (`deleted_at`),
  KEY `currently_published_tool_id` (`currently_published_tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table tool_engagement
# ------------------------------------------------------------

CREATE TABLE `tool_engagement` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `user_id` int(11) unsigned NOT NULL,
  `tool_uid` varchar(36) NOT NULL DEFAULT '',
  `text` text,
  `create_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  `submitted_at` datetime DEFAULT NULL,
  `deleted_at` datetime DEFAULT NULL,
  `score` float DEFAULT NULL,
  PRIMARY KEY (`uid`),
  KEY `user_id` (`user_id`),
  KEY `tool_id` (`tool_uid`),
  KEY `create_at` (`create_at`),
  KEY `updated_at` (`updated_at`),
  KEY `submitted_at` (`submitted_at`),
  KEY `deleted_at` (`deleted_at`),
  KEY `score` (`score`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table tool_engagement_answer
# ------------------------------------------------------------

CREATE TABLE `tool_engagement_answer` (
  `uid` varchar(36) NOT NULL DEFAULT '',
  `tool_engagement_uid` varchar(36) NOT NULL DEFAULT '',
  `question_index` int(10) unsigned NOT NULL,
  `choice_index` int(10) unsigned NOT NULL,
  PRIMARY KEY (`uid`),
  UNIQUE KEY `tool_engagement_uid` (`tool_engagement_uid`,`question_index`),
  KEY `tool_engagement_id` (`tool_engagement_uid`),
  KEY `question_index` (`question_index`),
  KEY `choice_index` (`choice_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



# Dump of table user
# ------------------------------------------------------------

CREATE TABLE `user` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id_from_idp` varchar(255) COLLATE utf8_unicode_ci NOT NULL DEFAULT '',
  `idp_id` int(11) unsigned NOT NULL,
  `email` varchar(255) CHARACTER SET utf8mb4 NOT NULL DEFAULT '',
  `fullname` varchar(255) CHARACTER SET utf8mb4 NOT NULL DEFAULT '',
  `adminLevel` enum('NONE','ADMIN','SUPER_ADMIN') CHARACTER SET utf8mb4 NOT NULL DEFAULT 'NONE',
  `last_login_at` datetime NOT NULL,
  `xapiConsented` tinyint(1) NOT NULL DEFAULT '0',
  `ssoData` text CHARACTER SET utf8mb4,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id_from_idp` (`user_id_from_idp`,`idp_id`),
  KEY `email` (`email`),
  KEY `xapiConsented` (`xapiConsented`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;



# Dump of table xapiQueue
# ------------------------------------------------------------

CREATE TABLE `xapiQueue` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `idp_id` int(11) NOT NULL,
  `statement` text CHARACTER SET utf8mb4 NOT NULL,
  `unique_tag` varchar(30) CHARACTER SET utf8mb4 NOT NULL DEFAULT '',
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_tag` (`unique_tag`),
  KEY `idp_id` (`idp_id`),
  KEY `created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;




/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
