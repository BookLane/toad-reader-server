const fs = require('fs')
const multiparty = require('multiparty')
const admzip = require('adm-zip')
const sharp = require('sharp')
const fetch = require('node-fetch')
const mime = require('mime')

const util = require('../utils/util')
const parseEpub = require('../utils/parseEpub')
const { getIndexedBook } = require('../utils/indexEpub')
const dueDateReminders = require('../crons/due_date_reminders')

module.exports = function (app, s3, connection, ensureAuthenticatedAndCheckIDP, log) {

  const deleteFolderRecursive = path => {
    log(['Delete folder', path], 2)
    if(fs.existsSync(path)) {
      fs.readdirSync(path).forEach(file => {
        const curPath = `${path}/${file}`
        if(fs.lstatSync(curPath).isDirectory()) { // recurse
          deleteFolderRecursive(curPath)
        } else { // delete file
          fs.unlinkSync(curPath)
        }
      })
      fs.rmdirSync(path)
    }
  }

  const emptyS3Folder = async Prefix => {
    log(['Empty S3 folder', Prefix], 2)
    const data = await s3.listObjects({
      Bucket: process.env.S3_BUCKET,
      Prefix,
    }).promise()

    if(data.Contents.length == 0) return

    const delParams = {
      Bucket: process.env.S3_BUCKET,
      Delete: {
        Objects: [],
      },
    }

    const overfull = data.Contents.length >= 1000
    data.Contents.slice(0,999).forEach(content => {
      delParams.Delete.Objects.push({ Key: content.Key })
    })

    if(delParams.Delete.Objects.length > 0) {
      await s3.deleteObjects(delParams).promise()
      if(overfull) {
        await emptyS3Folder(Prefix)
      }
    }
  }

  const deleteBook = async (bookId, next) => {
    log(['Delete book', bookId], 2)
    await util.runQuery({
      query: 'DELETE FROM `book` WHERE id=:bookId',
      vars: {
        bookId,
      },
      connection,
      next,
    })

    await deleteBookSearchIndexRows(bookId, next)

    await emptyS3Folder(`epub_content/book_${bookId}/`)
  }

  const deleteBookIfUnassociated = async (bookId, next) => {
    // clear out book and its user data, if book unassociated

    log(['Check if book is unassociated', bookId]);
    const rows = await util.runQuery({
      query: 'SELECT * FROM `book-idp` WHERE book_id=:bookId LIMIT 1',
      vars: {
        bookId,
      },
      connection,
      next,
    })

    if(rows.length > 0) return

    log(['Check if book is unused', bookId])
    const results = await util.runQuery({
      queries: [
        'SELECT id FROM book_instance WHERE book_id=:bookId LIMIT 1',
        'SELECT subscription_id FROM \`subscription-book\` WHERE book_id=:bookId LIMIT 1',
      ],
      vars: {
        bookId,
      },
      connection,
      next,
    })

    if(results.some(rows2 => rows2.length > 0)) return

    await deleteBook(bookId, next)
  }

  const deleteBookSearchIndexRows = async (bookId, next) => {
    log(['Delete book search index rows', bookId], 2)
    await util.runQuery({
      queries: [
        'DELETE FROM `book_textnode_index` WHERE book_id=:bookId',
        'DELETE FROM `book_textnode_index_term` WHERE book_id=:bookId',
      ],
      vars: {
        bookId,
      },
      connection,
      next,
    })
  }

  // delete a book
  app.delete(['/', '/book/:bookId'], ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to delete book', 3);
      res.status(403).send({ errorType: "biblemesh_no_permission" });
      return;
    }

    await util.runQuery({
      query: 'DELETE FROM `book-idp` WHERE book_id=:bookId AND idp_id=:idpId',
      vars: {
        bookId: req.params.bookId,
        idpId: req.user.idpId,
      },
      connection,
      next,
    })

    log('Delete (idp disassociation) successful', 2)

    await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: req.params.bookId, connection, log })

    res.send({ success: true });
          
  })

  // import book
  app.post('/importbook.json', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    const tmpDir = `tmp_epub_${util.getUTCTimeStamp()}`
    const toUploadDir = `${tmpDir}/toupload`
    const epubFilePaths = []
    let bookRow, cleanUpBookIdpToDelete
    const { replaceExisting } = req.query

    deleteFolderRecursive(tmpDir)

    fs.mkdirSync(tmpDir)

    const form = new multiparty.Form({
      uploadDir: tmpDir
    })

    let processedOneFile = false  // at this point, we only allow one upload at a time

    form.on('file', async (name, file) => {

      if(processedOneFile) return
      processedOneFile = true

      try {

        if(!req.user.isAdmin) {
          throw new Error(`biblemesh_no_permission`)
        }
  
        const putEPUBFile = async (relfilepath, body) => {
          const key = relfilepath
            ? `epub_content/book_${bookRow.id}/${relfilepath}`
            : `epub_content/covers/book_${bookRow.id}.png`
          
          log(['Upload file to S3', key])
  
          await s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentLength: body.byteCount,
            ContentType: mime.getType(key),
          }).promise()
  
          log(['...uploaded to S3', key])
        }
  
        const getEPUBFilePaths = path => {
          if(fs.existsSync(path)) {
            fs.readdirSync(path).forEach(file => {
              const curPath = `${path}/${file}`
              if(fs.lstatSync(curPath).isDirectory()) { // recurse
                getEPUBFilePaths(curPath)
              } else {
                epubFilePaths.push(curPath)
              }
            })
          }
        }
    
        const filename = file.originalFilename

        if(!filename) {
          throw new Error(`biblemesh_invalid_filename`)
        }

        const priceMatch = filename.match(/\$([0-9]+)\.([0-9]{2})(\.[^\.]+)?$/)
        const epubSizeInMB = Math.ceil(file.size/1024/1024)

        if(epubSizeInMB > req.user.idpMaxMBPerBook) {
          throw new Error(`biblemesh_file_too_large`)
        }

        bookRow = {
          title: 'Unknown',
          author: '',
          isbn: '',
          epubSizeInMB,
          standardPriceInCents: priceMatch ? (priceMatch[1] + priceMatch[2]) : null,
          updated_at: util.timestampToMySQLDatetime()
        }

        // Put row into book table
        log(['Insert book row', bookRow], 2)
        bookRow.id = (await util.runQuery({
          query: 'INSERT INTO `book` SET ?',
          vars: bookRow,
          connection,
          next,
        })).insertId

        await emptyS3Folder(`epub_content/book_${bookRow.id}/`)

        deleteFolderRecursive(toUploadDir)

        fs.mkdirSync(toUploadDir)

        const zip = new admzip(file.path)
        zip.extractAllTo(toUploadDir)

        fs.renameSync(file.path, `${toUploadDir}/book.epub`)

        getEPUBFilePaths(toUploadDir)
        await Promise.all(epubFilePaths.map(path => (
          putEPUBFile(path.replace(toUploadDir + '/', ''), fs.createReadStream(path))
        )))

        // TODO: make fonts public

        // after files uploaded
        const { title, author, isbn, coverHref, spines, success } = await parseEpub({ baseUri: toUploadDir, log })

        if(!success) {
          throw Error(`biblemesh_unable_to_process`)
        }

        // prep to insert the book row
        bookRow.title = title || 'Unknown'
        bookRow.author = author || ''
        bookRow.isbn = isbn || ''
        bookRow.updated_at = util.timestampToMySQLDatetime()

        if(coverHref) {
          const imgData = await (
            sharp(`${toUploadDir}/${coverHref}`)
              .resize(284)  // twice of the 142px width that is shown on the share page
              .png()
              .toBuffer()
          )
          await putEPUBFile(null, imgData)
        }

        // create and save search index
        let indexObj, searchTermCounts
        try {
          indexedBook = await getIndexedBook({ baseUri: toUploadDir, spines, log })
          await putEPUBFile('search_index.json', indexedBook.jsonStr)
          indexObj = indexedBook.indexObj
          searchTermCounts = indexedBook.searchTermCounts
        } catch(e) {
          log(e.message, 3)
          throw Error(`search_indexing_failed`)
        }

        // clean up
        deleteFolderRecursive(tmpDir)

        // check if book already exists in same idp group
        log('Look for identical book in idp group')
        const rows = await util.runQuery({
          query: `
            SELECT
              b.id,
              IF(bi.idp_id=:idpId, 1, 0) as alreadyBookInThisIdp

            FROM book as b
              LEFT JOIN \`book-idp\` as bi ON (b.id = bi.book_id)
              LEFT JOIN idp_group_member as igm1 ON (bi.idp_id = igm1.idp_id)
              LEFT JOIN idp_group_member as igm2 ON (igm1.idp_group_id = igm2.idp_group_id)

            WHERE b.title=:title
              AND b.author=:author
              AND b.isbn=:isbn
              AND (
                bi.idp_id=:idpId
                OR igm2.idp_id=:idpId
              )

            ORDER BY alreadyBookInThisIdp DESC

            LIMIT 1
          `,
          vars: {
            ...bookRow,
            idpId: req.user.idpId,
          },
          connection,
          next,
        })

        if(rows.length === 1 && !replaceExisting) {

          // delete book
          await deleteBook(bookRow.id, next)

          if(rows[0].alreadyBookInThisIdp == '1') {
            log('Import unnecessary (book already associated with this idp)', 2)
            res.send({
              success: true,
              note: 'already-associated',
              bookId: rows[0].id,
            })

          } else {
            const vars = cleanUpBookIdpToDelete = {
              book_id: rows[0].id,
              idp_id: req.user.idpId
            }
            log(['INSERT book-idp row', vars], 2)
            await util.runQuery({
              query: 'INSERT INTO `book-idp` SET ?',
              vars,
              connection,
              next,
            })

            await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: rows[0].id, connection, log })

            log('Import unnecessary (book exists in idp with same group; added association)', 2)
            res.send({
              success: true,
              note: 'associated-to-existing',
              bookId: rows[0].id,
            })

          }
          
          return
        }

        if(replaceExisting) {
          const row = rows[0]

          if(!row || row.alreadyBookInThisIdp != '1') {
            throw new Error(`does-not-exist`)
          }

          // copy the old s3 dir to `book_XX--replaced-[timestamp]`
          await util.s3CopyFolder({
            source: `epub_content/book_${row.id}/`,
            destination: `epub_content/book_${row.id}--replaced-${Date.now()}/`,
          })

          // copy new s3 dir to where old was
          await util.s3CopyFolder({
            source: `epub_content/book_${bookRow.id}/`,
            destination: `epub_content/book_${row.id}/`,
          })

          // delete the new book
          await deleteBook(bookRow.id, next)

          // delete the search index rows for the old book
          deleteBookSearchIndexRows(row.id, next)

          // change bookRow.id so that the existing row gets updated
          bookRow.id = row.id

        } else {
          const vars = cleanUpBookIdpToDelete = {
            book_id: bookRow.id,
            idp_id: req.user.idpId,
          }
          log(['INSERT book-idp row', vars], 2)
          await util.runQuery({
            query: 'INSERT INTO `book-idp` SET ?',
            vars,
            connection,
            next,
          })
        }

        // From this point, we expect it to be successful. Send some info to keep the connection alive.
        res.set('Content-Type', 'application/json')
        res.write(`{`)
        let timeOfLastResponseWrite = Date.now()
        let writeResponseIndex = 0
        const addToResponseToKeepAlive = () => {
          if(Date.now() > timeOfLastResponseWrite + 1000*30) {
            res.write(`"ignore-${writeResponseIndex++}":0,`)
            timeOfLastResponseWrite = Date.now()
          }
        }

        const numInsertsAtOnce = 500

        // save search index to db (needs to be down here after bookRow.id gets updated if replaceExisting is true)
        const storedFields = Object.values(indexObj.storedFields)
        for(let i=0; i<storedFields.length; i+=numInsertsAtOnce) {
          const chunk = storedFields.slice(i, i+numInsertsAtOnce)

          util.convertJsonColsToStrings({ tableName: 'book_textnode_index', rows: chunk })

          log([`INSERT ${numInsertsAtOnce} book_textnode_index rows from index ${i}...`], 2)
          await util.runQuery({
            query: `INSERT INTO book_textnode_index (id, book_id, spineIdRef, text, hitIndex, context) VALUES ${chunk.map(x => `(?,?,?,?,?,?)`).join(',')}`,
            vars: chunk.map(textnodeInfo => ([
              textnodeInfo.id,
              bookRow.id,
              textnodeInfo.spineIdRef,
              textnodeInfo.text,
              textnodeInfo.hitIndex,
              textnodeInfo.context,
            ])).flat(),
            connection,
            next,
          })

          addToResponseToKeepAlive()
        }

        // save search index terms to db (needs to be down here after bookRow.id gets updated if replaceExisting is true)
        const searchTerms = Object.keys(searchTermCounts)
          .filter(searchTerm => searchTermCounts[searchTerm])
        for(let i=0; i<searchTerms.length; i+=numInsertsAtOnce) {
          const chunk = searchTerms.slice(i, i+numInsertsAtOnce)

          log([`INSERT ${numInsertsAtOnce} book_textnode_index_term rows from index ${i}...`], 2)
          await util.runQuery({
            query: `INSERT INTO book_textnode_index_term (term, count, book_id) VALUES ${chunk.map(x => `(?,?,?)`).join(',')}`,
            vars: chunk.map(searchTerm => ([
              searchTerm,
              searchTermCounts[searchTerm],
              bookRow.id,
            ])).flat(),
            connection,
            next,
          })

          addToResponseToKeepAlive()
        }

        // these need to be down here after bookRow.id gets updated if replaceExisting is true
        bookRow.coverHref = `epub_content/book_${bookRow.id}/${coverHref}`
        bookRow.rootUrl = `epub_content/book_${bookRow.id}`

        log(['Update book row', bookRow.id, bookRow], 2)
        await util.runQuery({
          query: 'UPDATE `book` SET :bookRow WHERE id=:bookId',
          vars: {
            bookId: bookRow.id,
            bookRow,
          },
          connection,
          next,
        })

        await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: bookRow.id, connection, log })

        log('Import successful', 2)
        try {  // If everything was successful, but the connection timed out, don't delete it.
          res.write(
            `"success": true,` +
            `"bookId": ${bookRow.id}` +
            `}`
          )
          res.end()
        } catch(e) {}

      } catch(err) {

        log(['Import book exception', err.message], 3)
  
        // clean up...
  
        try {
          if(cleanUpBookIdpToDelete) {
            await util.runQuery({
              query: 'DELETE FROM `book-idp` WHERE idp_id=:idpId AND book_id=:bookId',
              vars: cleanUpBookIdpToDelete,
              connection,
              next,
            })
          }
        } catch(err2) {}
  
        try {

          if(bookRow) {
            await deleteBookIfUnassociated(bookRow.id, next)
            await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: bookRow.id, connection, log })
          }

          deleteFolderRecursive(tmpDir)
  
        } catch(err3) {
          log(['Error in responding to import error!', err3.message], 3)
        }

        res.status(400).send({
          errorType: /^[-_a-z]+$/.test(err.message) ? err.message : "biblemesh_unable_to_process",
          maxMB: req.user.idpMaxMBPerBook,
        })
      }
  
    })

    form.on('error', err => {
      res.status(400).send({ errorType: `biblemesh_bad_file` })
    })

    form.parse(req)

  })

  // import file
  app.post(
    '/importfile/:classroomUid',
    ensureAuthenticatedAndCheckIDP,
    async (req, res, next)  => {

      const { classroomUid } = req.params

      await util.dieOnNoClassroomEditPermission({
        connection,
        next,
        req,
        log,
        classroomUid,
      })

      const tmpDir = 'tmp_file_' + util.getUTCTimeStamp()

      deleteFolderRecursive(tmpDir)

      fs.mkdir(tmpDir, err => {
        if(err) return next(err)

        const form = new multiparty.Form({
          uploadDir: tmpDir,
        })

        let processedOneFile = false  // at this point, we only allow one upload at a time

        form.on('file', (name, file) => {

          if(processedOneFile) return
          processedOneFile = true

          const filename = file.originalFilename
            .replace(/[^a-z0-9._-]/gi, '')
            .replace(/(\.[^.]+)$/gi, `-${Date.now()}$1`)

          if(!filename || !/-[0-9]+\.[^.]+$/.test(filename)) {
            deleteFolderRecursive(tmpDir)
            res.status(400).send({ errorType: "biblemesh_invalid_filename" })
            return
          }

          const fileSizeInMB = Math.ceil(file.size/1024/1024)

          if(fileSizeInMB > req.user.idpMaxMBPerFile) {
            res.status(400).send({
              errorType: "biblemesh_file_too_large",
              maxMB: req.user.idpMaxMBPerFile,
            })
            return
          }

          const body = fs.createReadStream(file.path)

          const key = 'enhanced_assets/' + classroomUid + '/' + filename
          log(['Upload file to S3', key])
          s3.putObject({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentLength: body.byteCount,
            ContentType: mime.getType(key),
          }, (err, data) => {
            // clean up
            deleteFolderRecursive(tmpDir)

            if(err) return next(err)

            res.send({
              success: true,
              filename,
            })
          })

        })

        form.on('error', err => {
          log(['importfile error', err], 3)
          deleteFolderRecursive(tmpDir)
          res.status(400).send({ errorType: "biblemesh_bad_file" })
        })

        form.parse(req)

      })

    }
  )

  // update subscription-book rows
  app.post('/setsubscriptions/:bookId', ensureAuthenticatedAndCheckIDP, async (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to modify subscriptions', 3)
      res.status(403).send({ errorType: "biblemesh_no_permission" })
      return
    }

    if(
      !util.paramsOk(req.body, ['subscriptions'])
      || req.body.subscriptions.some(subscription => !util.paramsOk(subscription, ['id', 'version']))
    ) {
      log(['Invalid parameter(s)', req.body], 3)
      res.status(400).send()
      return
    }

    const [ currentSubscriptionBookRows, bookOnIdp, subscriptionOnIdp ] = await util.runQuery({
      query: `
        SELECT sb.subscription_id, sb.version
        FROM \`subscription-book\` as sb
          LEFT JOIN subscription as s ON (s.id=sb.subscription_id)
          LEFT JOIN \`book-idp\` as bi ON (bi.book_id=sb.book_id)
        WHERE bi.book_id=:bookId
          AND bi.idp_id=:idpId
          AND (
            sb.subscription_id=:negativeIdpId
            OR (
              s.idp_id=:idpId
              AND s.deleted_at IS NULL
            )
          )
        ;

        SELECT bi.book_id
        FROM \`book-idp\` as bi
        WHERE bi.book_id=:bookId
          AND bi.idp_id=:idpId
        ;

        SELECT s.id
        FROM subscription as s
        WHERE s.idp_id=:idpId
          AND s.deleted_at IS NULL
      `,
      vars: {
        bookId: req.params.bookId,
        idpId: req.user.idpId,
        negativeIdpId: req.user.idpId * -1,
      },
      connection,
      next,
    })

    if(bookOnIdp.length === 0) {
      log('No permission to modify subscriptions on this book', 3)
      res.status(403).send({ errorType: "biblemesh_no_permission" })
      return
    }

    const subscriptionIdOptions = subscriptionOnIdp.map(({ id }) => id)
    let { subscriptions } = req.body
    const queries = []
    const vars = []

    // delete old
    currentSubscriptionBookRows.forEach(({ subscription_id }) => {
      if(!subscriptions.some(({ id }) => id === subscription_id)) {
        queries.push(`DELETE FROM \`subscription-book\` WHERE subscription_id=? AND book_id=?`)
        vars.push(subscription_id)
        vars.push(req.params.bookId)
      }
    })

    // update existing
    subscriptions = subscriptions.filter(subscription => (
      !currentSubscriptionBookRows.some(({ subscription_id, version }) => {
        if(subscription_id === subscription.id) {
          if(subscription.version !== version) {
            queries.push(`UPDATE \`subscription-book\` SET version=? WHERE subscription_id=? AND book_id=?`)
            vars.push(version)
            vars.push(subscription_id)
            vars.push(req.params.bookId)
          }
          return true
        }
      })
    ))

    // add new
    if(subscriptions.some(({ id, version }) => {
      if(
        id !== req.user.idpId * -1
        && !subscriptionIdOptions.includes(id)
      ) {
        return true
      }
      queries.push(`INSERT INTO \`subscription-book\` SET ?`)
      vars.push({
        subscription_id: id,
        version,
        book_id: req.params.bookId,
      })
    })) {
      log('No permission to add requested subscription', 3)
      res.status(403).send({ errorType: "biblemesh_no_permission" })
      return
    }

    await util.runQuery({
      queries,
      vars,
      connection,
      next,
    })

    await util.updateComputedBookAccess({ idpId: req.user.idpId, bookId: req.params.bookId, connection, log })

    res.send({ success: true })

  })

  // usage costs
  app.get('/reportsinfo', ensureAuthenticatedAndCheckIDP, (req, res, next) => {

    if(!req.user.isAdmin) {
      log('No permission to view usage costs', 3)
      res.status(403).send({ errorType: "biblemesh_no_permission" })
      return
    }

    const reportInfo = [
      {
        tab: req.user.idpName,
        data: [],
      },
    ]
    let idpIndex = 0

    const date = new Date()
    date.setMonth(date.getMonth() + 1)
    const monthSets = []

    for(let i=0; i<(req.query.numMonths || 3); i++) {
      const toDate = `${date.getUTCFullYear()}-${util.pad(date.getUTCMonth() + 1, 2)}-01 00:00:00`
      date.setMonth(date.getMonth() - 1)
      const fromDate = `${date.getUTCFullYear()}-${util.pad(date.getUTCMonth() + 1, 2)}-01 00:00:00`

      monthSets.push({
        fromDate,
        toDate,
        heading: date.toLocaleString('default', { month: 'long', year: 'numeric' }),
      })
    }

    const buildOutUserList = () => {
      connection.query(
        `
          SELECT
            u.email as Email,
            u.fullname as Name,
            u.created_at as Created
          FROM user as u
          WHERE u.idp_id=:idpId
            AND u.adminLevel!="SUPER_ADMIN"
        `,
        {
          idpId: req.user.idpId,
        },
        (err, userRows) => {
          if (err) return next(err)

          userRows.forEach(userRow => {
            userRow.Created = userRow.Created.split(" ")[0]
          })

          reportInfo[idpIndex].data.push({
            heading: `User List`,
            rows: userRows,
            summary: `Total number of users: ${userRows.length}`,
          })

          log('Deliver the report')
          res.send(reportInfo)
        }
      )
    }

    const buildOutMonths = () => {

      if(monthSets.length > 0) {
        const monthSet = monthSets.shift()

        connection.query(`
            SELECT
              b.id,
              b.title,
              b.standardPriceInCents,
              b.epubSizeInMB,
              COUNT(*) as numUsers
            FROM book_instance as bi
              LEFT JOIN book as b ON (b.id = bi.book_id)
            WHERE bi.idp_id=:idpId
              AND bi.first_given_access_at>=:fromDate
              AND bi.first_given_access_at<:toDate
            GROUP BY b.id
            ;

            SELECT b.id, b.title, COUNT(*) as numDownloads
            FROM book_download as bd
              LEFT JOIN book as b ON (b.id=bd.book_id)
            WHERE bd.idp_id=:idpId
              AND bd.downloaded_at>=:fromDate
              AND bd.downloaded_at<:toDate
            GROUP BY b.id
            ;

            SELECT COUNT(*) as numActiveUsers
            FROM (
              SELECT COUNT(*)
              FROM user as u
                LEFT JOIN latest_location as ll ON (ll.user_id=u.id)
              WHERE u.idp_id=:idpId
                AND ll.updated_at>=:fromDate
                AND ll.updated_at<:toDate
              GROUP BY u.id
            ) as ll_per_u
          `,
          {
            idpId: req.user.idpId,
            ...monthSet,
          },
          (err, results) => {
            if (err) return next(err)

            let [ usageCostRows, bookDownloadRows, activeUsersRows ] = results

            let totalCost = 0

            usageCostRows = usageCostRows.map(({ id, title, standardPriceInCents, epubSizeInMB, numUsers }) => {
              const standardPrice = parseInt(standardPriceInCents || 0) / 100
              epubSizeInMB = parseInt(epubSizeInMB) || 0
              numUsers = parseInt(numUsers)
              const bookInstanceCost = Math.max(Math.round((epubSizeInMB * 0.0015 + standardPrice * 0.015) * 100) / 100, .05)

              totalCost += numUsers * bookInstanceCost

              return {
                "Book": `${title} (id: ${id})`,
                "Standard price": `$${standardPrice.toFixed(2)}`,
                "EPUB size in MB": epubSizeInMB,
                "Instance cost": `$${bookInstanceCost.toFixed(2)}`,
                "Users granted access": numUsers,
                "Cost": `$${(numUsers * bookInstanceCost).toFixed(2)}`,
              }
            })
      
            reportInfo[idpIndex].data.push({
              heading: `${monthSet.heading} – Usage Cost`,
              rows: usageCostRows,
              summary: `Total usage cost: ${Math.max(totalCost, 100).toFixed(2)}`,
            })

            let totalDownloads = 0

            bookDownloadRows = bookDownloadRows.map(({ id, title, numDownloads }) => {
              numDownloads = parseInt(numDownloads, 10) || 0
              totalDownloads += numDownloads

              return {
                "Book": `${title} (id: ${id})`,
                "Downloads to native apps": numDownloads,
              }
            })
      
            reportInfo[idpIndex].data.push({
              heading: `${monthSet.heading} – Book Downloads`,
              rows: bookDownloadRows,
              summary: `Total number of downloads: ${totalDownloads}`,
            })

            reportInfo[idpIndex].data.push({
              heading: `${monthSet.heading} – Total active users: ${activeUsersRows[0].numActiveUsers}`,
              rows: [],
              summary: ``,
            })

            buildOutMonths()
          }
        )

      } else {

        buildOutUserList()

      }
    }

    buildOutMonths()
  })

  ////////////// CRONS //////////////

  var next = function(err) {
    if(err) {
      log(err, 3);
    }
  }

  // hourly: clear out all expired demo tenants
  var runHourlyCron = function() {
    log('Hourly cron started', 2);

    var currentMySQLDatetime = util.timestampToMySQLDatetime();

    log('Get expired idps');
    connection.query('SELECT id FROM `idp` WHERE demo_expires_at IS NOT NULL AND demo_expires_at<?',
      [currentMySQLDatetime],
      function (err, rows, fields) {
        if (err) return log(err, 3);

        var expiredIdpIds = rows.map(function(row) { return parseInt(row.id); });

        log('Get books which are owned by the expired idps');
        connection.query('SELECT book_id FROM `book-idp` WHERE idp_id IN(?)',
          [expiredIdpIds.concat([0])],
          function (err2, rows2, fields2) {
            if (err2) return log(err2, 3);

            var deleteQueries = ['SELECT 1'];  // dummy query, in case there are no idps to delete

            expiredIdpIds.forEach(function(idpId) {
              log(['Clear out idp tenant', idpId], 2);

              deleteQueries.push('DELETE FROM `book-idp` WHERE idp_id="' + idpId + '"');
              deleteQueries.push('DELETE FROM `idp` WHERE id="' + idpId + '"');
              deleteQueries.push('DELETE FROM `highlight` WHERE user_id="' + (idpId * -1) + '"');
              deleteQueries.push('DELETE FROM `latest_location` WHERE user_id="' + (idpId * -1) + '"');
            });

            connection.query(deleteQueries.join('; '),
              async (err3, result3) => {
                if (err3) return log(err3, 3);

                await Promise.all(expiredIdpIds.map(idpId => util.updateComputedBookAccess({ idpId, connection, log })))

                var booksOwnedByDeletedIdps = [];
                rows2.forEach(function(row2) {
                  var bookId = parseInt(row2.book_id);
                  if(booksOwnedByDeletedIdps.indexOf(bookId) == -1) {
                    booksOwnedByDeletedIdps.push(bookId);
                  }
                });

                log(['Books to potentially delete', booksOwnedByDeletedIdps]);

                var handleNextBook = function() {
                  var nextBookId = booksOwnedByDeletedIdps.pop();
                  if(nextBookId != undefined) {
                    deleteBookIfUnassociated(nextBookId, next, handleNextBook);
                  } else {
                    log('Hourly cron complete', 2);
                  }
                }
                handleNextBook();
              }
            );
          }
        );
      }
    );

    // dueDateReminders({ connection, next, log })

  }

  setInterval(runHourlyCron, 1000 * 60 * 60);
  runHourlyCron();

  // every minute: send xapi statements
  var minuteCronRunning = false;
  var runMinuteCron = function() {

    if(minuteCronRunning) {
      log('Minute cron skipped since previous run unfinished.');
      return;
    }

    log('Minute cron started', 2);
    minuteCronRunning = true;

    // get the tenants (idps)
    var currentMySQLDatetime = util.timestampToMySQLDatetime();

    log('Get idps with xapiOn=true');
    connection.query('SELECT * FROM `idp` WHERE xapiOn=? AND (demo_expires_at IS NULL OR demo_expires_at>?)',
      [1, currentMySQLDatetime],
      function (err, rows) {
        if (err) {
          log(err, 3);
          minuteCronRunning = false;
          return;
        }

        var leftToDo = rows.length;

        var markDone = function() {
          if(--leftToDo <= 0) {
            log('Minute cron complete', 2);
            minuteCronRunning = false;
          }
        }

        if(rows.length === 0) {
          markDone();
          return;
        }

        rows.forEach(function(row) {

          // check configuration
          if(!row.xapiEndpoint || !row.xapiUsername || !row.xapiPassword || row.xapiMaxBatchSize < 1) {
            log('The IDP with id #' + row.id + ' has xapi turned on, but it is misconfigured. Skipping.', 3);
            markDone();
            return;
          }

          // get the xapi queue
          log('Get xapiQueue for idp id #' + row.id);
          connection.query('SELECT * FROM `xapiQueue` WHERE idp_id=? ORDER BY created_at DESC LIMIT ?',
            [row.id, row.xapiMaxBatchSize],
            function (err, statementRows) {
              if (err) {
                log(err, 3);
                markDone();
                return;
              }

              var statements = [];
  
              statementRows.forEach(function(statementRow) {
                statements.push(JSON.parse(statementRow.statement));
              });

              if(statements.length > 0) {

                var endpoint = row.xapiEndpoint.replace(/(\/statements|\/)$/, '') + '/statements';

                var options = {
                  method: 'post',
                  body: JSON.stringify(statements),
                  headers: {
                    'Authorization': 'Basic ' + Buffer.from(row.xapiUsername + ":" + row.xapiPassword).toString('base64'),
                    'X-Experience-API-Version': '1.0.0',
                    'Content-Type': 'application/json',
                  },
                }
    
                // post the xapi statements
                fetch(endpoint, options)
                  .then(function(res) {
                    if(res.status !== 200) {
                      res.json().then(function(json) {
                        log(['Bad xapi post for idp id #' + row.id, json.warnings || json, JSON.stringify(statements)], 3);
                        markDone();
                      })
                      return;
                    }

                    log(statements.length + ' xapi statement(s) posted successfully for idp id #' + row.id);

                    var statementIds = [];
                    statementRows.forEach(function(statementRow) {
                      statementIds.push(statementRow.id);
                    });
          
                    log('Delete successfully sent statements from xapiQueue queue. Ids: ' + statementIds.join(', '));
                    connection.query('DELETE FROM `xapiQueue` WHERE id IN(?)', [statementIds], function (err, result) {
                      if (err) log(err, 3);
                      markDone();
                    });
          
                  })
                  .catch(function(err) {
                    log('Xapi post failed for idp id #' + row.id, 3);
                    markDone();
                  })

              } else {
                markDone();
              }
            }
          );
        });
      }
    );

    dueDateReminders({ connection, next, log })

  }

  setInterval(runMinuteCron, 1000 * 60);
  runMinuteCron();

  
}