(function () {
  'use strict';

  /**
   * @ngdoc overview
   * @name ui.grid.treeBase
   * @description
   *
   *  # ui.grid.treeBase
   * This module provides base tree handling functions that are shared by other features, notably grouping 
   * and treeView.  It provides a tree view of the data, with nodes in that
   * tree and leaves.
   * 
   * Design information:
   * -------------------
   * 
   * The raw data that is provided must come with a $$treeLevel on any non-leaf node.  Grouping will create
   * these on all the group header rows, treeView will expect these to be set in the raw data by the user.
   * TreeBase will run a rowsProcessor that:
   *  - builds `treeBase.tree` out of the provided rows
   *  - permits a recursive sort of the tree
   *  - maintains the expand/collapse state of each node
   *  - provides the expand/collapse all button and the expand/collapse buttons
   *  - maintains the count of children for each node
   * 
   * Each row is updated with a link to the tree node that represents it.  Refer {@link ui.grid.treeBase.grid:treeBase.tree tree documentation}
   * for information.
   * 
   *  TreeBase adds information to the rows 
   *  - treeLevel: if present and > -1 tells us the level (level 0 is the top level) 
   *  - treeNode: pointer to the node in the grid.treeBase.tree that refers
   *    to this row, allowing us to manipulate the state
   * 
   * Since the logic is baked into the rowsProcessors, it should get triggered whenever
   * row order or filtering or anything like that is changed.  We recall the expanded state
   * across invocations of the rowsProcessors by the reference to the treeNode on the individual
   * rows.  We rebuild the tree itself quite frequently, when we do this we use the saved treeNodes to
   * get the state, but we overwrite the other data in that treeNode.
   * 
   * By default rows are collapsed, which means all data rows have their visible property
   * set to false, and only level 0 group rows are set to visible.
   * 
   * We rely on the rowsProcessors to do the actual expanding and collapsing, so we set the flags we want into
   * grid.treeBase.tree, then call refresh.  This is because we can't easily change the visible
   * row cache without calling the processors, and once we've built the logic into the rowProcessors we may as
   * well use it all the time.
   * 
   * Tree base provides sorting (on non-grouped columns).
   * 
   * Sorting works in two passes.  The standard sorting is performed for any columns that are important to building 
   * the tree (for example, any grouped columns).  Then after the tree is built, a recursive tree sort is performed
   * for the remaining sort columns (including the original sort) - these columns are sorted within each tree level 
   * (so all the level 1 nodes are sorted, then all the level 2 nodes within each level 1 node etc).
   * 
   * To achieve this we make use of the `ignoreSort` property on the sort configuration.  The parent feature (treeView or grouping)
   * must provide a rowsProcessor that runs with very low priority (typically in the 60-65 range), and that sets
   * the `ignoreSort`on any sort that it wants to run on the tree.  TreeBase will clear the ignoreSort on all sorts - so it
   * will turn on any sorts that haven't run.  It will then call a recursive sort on the tree.
   * 
   * Tree base provides aggregation.  It checks the aggregation configuration on each column, and aggregates based on
   * the logic provided as it builds the tree.  Aggregation information will be collected in the format:
   * 
   * ```
   *   {
   *     type: 'count',
   *     value: 4,
   *     label: 'count: ',
   *     rendered: 'count: 4'
   *   }
   * ```
   * 
   * A callback is provided to format the value once it is finalised (aka a valueFilter).
   *  
   * <br/>
   * <br/>
   *
   * <div doc-module-components="ui.grid.treeBase"></div>
   */

  var module = angular.module('ui.grid.treeBase', ['ui.grid']);

  /**
   *  @ngdoc object
   *  @name ui.grid.treeBase.constant:uiGridTreeBaseConstants
   *
   *  @description constants available in treeBase module
   * 
   */
  module.constant('uiGridTreeBaseConstants', {
    featureName: "treeBase",
    rowHeaderColName: 'treeBaseRowHeaderCol',
    EXPANDED: 'expanded',
    COLLAPSED: 'collapsed',
    aggregation: {
      COUNT: 'count',
      SUM: 'sum',
      MAX: 'max',
      MIN: 'min',
      AVG: 'avg',
      CUSTOM: 'custom'
    }
  });

  /**
   *  @ngdoc service
   *  @name ui.grid.treeBase.service:uiGridTreeBaseService
   *
   *  @description Services for treeBase feature
   */
  /**
   *  @ngdoc object
   *  @name ui.grid.treeBase.api:ColumnDef
   *
   *  @description ColumnDef for tree feature, these are available to be 
   *  set using the ui-grid {@link ui.grid.class:GridOptions.columnDef gridOptions.columnDefs}
   */

  module.service('uiGridTreeBaseService', ['$q', 'uiGridTreeBaseConstants', 'gridUtil', 'GridRow', 'gridClassFactory', 'i18nService', 'uiGridConstants', 'rowSorter',
  function ($q, uiGridTreeBaseConstants, gridUtil, GridRow, gridClassFactory, i18nService, uiGridConstants, rowSorter) {

    var service = {

      initializeGrid: function (grid, $scope) {

        //add feature namespace and any properties to grid for needed
        /**
         *  @ngdoc object
         *  @name ui.grid.treeBase.grid:treeBase
         *
         *  @description Grid properties and functions added for treeBase
         */
        grid.treeBase = {};

        /**
         *  @ngdoc property
         *  @propertyOf ui.grid.treeBase.grid:treeBase
         *  @name numberLevels
         *
         *  @description Total number of tree levels currently used, calculated by the rowsProcessor by 
         *  retaining the highest tree level it sees 
         */
        grid.treeBase.numberLevels = 0;

        /**
         *  @ngdoc property
         *  @propertyOf ui.grid.treeBase.grid:treeBase
         *  @name expandAll
         *
         *  @description Whether or not the expandAll box is selected
         */
        grid.treeBase.expandAll = false;
        
        /**
         *  @ngdoc property
         *  @propertyOf ui.grid.treeBase.grid:treeBase
         *  @name tree
         *
         *  @description Tree represented as a nested array that holds the state of each node, along with a
         *  pointer to the row.  The array order is material - we will display the children in the order
         *  they are stored in the array
         * 
         *  Each node stores:
         * 
         *    - the state of this node
         *    - an array of children of this node
         *    - a pointer to the parent of this node (reverse pointer, allowing us to walk up the tree)
         *    - the number of children of this node
         *    - aggregation information calculated from the nodes
         *
         *  ```
         *    [{
         *      state: 'expanded',
         *      row: <reference to row>,
         *      parentRow: null,
         *      aggregations: [{
         *        type: 'count',
         *        col: <gridCol>,
         *        value: 2,
         *        label: 'count: ',
         *        rendered: 'count: 2'
         *      }],
         *      children: [
         *        {
         *          state: 'expanded',
         *          row: <reference to row>,
         *          parentRow: <reference to row>,
         *          aggregations: [{
         *            type: 'count',
         *            col: '<gridCol>,
         *            value: 4,
         *            label: 'count: ',
         *            rendered: 'count: 4'
         *          }],
         *          children: [
         *            { state: 'expanded', row: <reference to row>, parentRow: <reference to row> },
         *            { state: 'collapsed', row: <reference to row>, parentRow: <reference to row> },
         *            { state: 'expanded', row: <reference to row>, parentRow: <reference to row> },
         *            { state: 'collapsed', row: <reference to row>, parentRow: <reference to row> }
         *          ]
         *        },
         *        {
         *          state: 'collapsed',
         *          row: <reference to row>,
         *          parentRow: <reference to row>,
         *          aggregations: [{
         *            type: 'count',
         *            col: <gridCol>,
         *            value: 3,
         *            label: 'count: ',
         *            rendered: 'count: 3'
         *          }],
         *          children: [
         *            { state: 'expanded', row: <reference to row>, parentRow: <reference to row> },
         *            { state: 'collapsed', row: <reference to row>, parentRow: <reference to row> },
         *            { state: 'expanded', row: <reference to row>, parentRow: <reference to row> }
         *          ]
         *        }
         *      ]
         *    }, {<another level 0 node maybe>} ]
         *  ```
         *  Missing state values are false - meaning they aren't expanded.
         * 
         *  This is used because the rowProcessors run every time the grid is refreshed, so
         *  we'd lose the expanded state every time the grid was refreshed.  This instead gives
         *  us a reliable lookup that persists across rowProcessors.
         * 
         *  This tree is rebuilt every time we run the rowsProcessors.  Since each row holds a pointer
         *  to it's tree node we can persist expand/collapse state across calls to rowsProcessor, we discard 
         *  all transient information on the tree (children, childCount) and recalculate it
         * 
         */
        grid.treeBase.tree = {};

        service.defaultGridOptions(grid.options);

        grid.registerRowsProcessor(service.treeRows, 410);

        grid.registerColumnBuilder( service.treeBaseColumnBuilder );

        service.createRowHeader( grid );

        /**
         *  @ngdoc object
         *  @name ui.grid.treeBase.api:PublicApi
         *
         *  @description Public Api for treeBase feature
         */
        var publicApi = {
          events: {
            treeBase: {
              /**
               * @ngdoc event
               * @eventOf ui.grid.treeBase.api:PublicApi
               * @name rowExpanded
               * @description raised whenever a row is expanded.  If you are dynamically 
               * rendering your tree you can listen to this event, and then retrieve
               * the children of this row and load them into the grid data.
               * 
               * When the data is loaded the grid will automatically refresh to show these new rows
               * 
               * <pre>
               *      gridApi.treeBase.on.rowExpanded(scope,function(row){})
               * </pre>
               * @param {gridRow} row the row that was expanded.  You can also 
               * retrieve the grid from this row with row.grid
               */
              rowExpanded: {},

              /**
               * @ngdoc event
               * @eventOf ui.grid.treeBase.api:PublicApi
               * @name rowCollapsed
               * @description raised whenever a row is collapsed.  Doesn't really have
               * a purpose at the moment, included for symmetry
               * 
               * <pre>
               *      gridApi.treeBase.on.rowCollapsed(scope,function(row){})
               * </pre>
               * @param {gridRow} row the row that was collapsed.  You can also 
               * retrieve the grid from this row with row.grid
               */
              rowCollapsed: {}
            }
          },

          methods: {
            treeBase: {
              /**
               * @ngdoc function
               * @name expandAllRows
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description Expands all tree rows
               */
              expandAllRows: function () {
                service.expandAllRows(grid);
              },

              /**
               * @ngdoc function
               * @name collapseAllRows
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description collapse all tree rows
               */
              collapseAllRows: function () {
                service.collapseAllRows(grid);
              },

              /**
               * @ngdoc function
               * @name toggleRowTreeState
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description  call expand if the row is collapsed, collapse if it is expanded
               * @param {gridRow} row the row you wish to toggle
               */
              toggleRowTreeState: function (row) {
                service.toggleRowTreeState(grid, row);
              },

              /**
               * @ngdoc function
               * @name expandRow
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description expand the immediate children of the specified row
               * @param {gridRow} row the row you wish to expand
               */
              expandRow: function (row) {
                service.expandRow(grid, row);
              },

              /**
               * @ngdoc function
               * @name expandRowChildren
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description expand all children of the specified row
               * @param {gridRow} row the row you wish to expand
               */
              expandRowChildren: function (row) {
                service.expandRowChildren(grid, row);
              },

              /**
               * @ngdoc function
               * @name collapseRow
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description collapse  the specified row.  When
               * you expand the row again, all grandchildren will retain their state
               * @param {gridRow} row the row you wish to collapse
               */
              collapseRow: function ( row ) {
                service.collapseRow(grid, row);
              },

              /**
               * @ngdoc function
               * @name collapseRowChildren
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description collapse all children of the specified row.  When
               * you expand the row again, all grandchildren will be collapsed
               * @param {gridRow} row the row you wish to collapse children for
               */
              collapseRowChildren: function ( row ) {
                service.collapseRowChildren(grid, row);
              },

              /**
               * @ngdoc function
               * @name getTreeState
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description Get the tree state for this grid,
               * used by the saveState feature
               * Returned treeState as an object 
               *   `{ expandedState: { uid: 'expanded', uid: 'collapsed' } }` 
               * where expandedState is a hash of row uid and the current expanded state
               * 
               * @returns {object} tree state
               * 
               * TODO - this needs work - we need an identifier that persists across instantiations,
               * not uid.  This really means we need a row identity defined, but that won't work for
               * grouping.  Perhaps this needs to be moved up to treeView and grouping, rather than 
               * being in base.
               */
              getTreeExpandedState: function () {
                return { expandedState: service.getTreeState(grid) };
              },

              /**
               * @ngdoc function
               * @name setTreeState
               * @methodOf  ui.grid.treeBase.api:PublicApi
               * @description Set the expanded states of the tree
               * @param {object} config the config you want to apply, in the format
               * provided by getTreeState
               */
              setTreeState: function ( config ) {
                service.setTreeState( grid, config );
              }
            }
          }
        };

        grid.api.registerEventsFromObject(publicApi.events);

        grid.api.registerMethodsFromObject(publicApi.methods);
      },


      defaultGridOptions: function (gridOptions) {
        //default option to true unless it was explicitly set to false
        /**
         *  @ngdoc object
         *  @name ui.grid.treeBase.api:GridOptions
         *
         *  @description GridOptions for treeBase feature, these are available to be
         *  set using the ui-grid {@link ui.grid.class:GridOptions gridOptions}
         */

        /**
         *  @ngdoc object
         *  @name treeRowHeaderBaseWidth
         *  @propertyOf  ui.grid.treeBase.api:GridOptions
         *  @description Base width of the tree header, provides for a single level of tree.  This
         *  is incremented by `treeIndent` for each extra level
         *  <br/>Defaults to 30
         */
        gridOptions.treeRowHeaderBaseWidth = gridOptions.treeRowHeaderBaseWidth || 30;

        /**
         *  @ngdoc object
         *  @name treeIndent
         *  @propertyOf  ui.grid.treeBase.api:GridOptions
         *  @description Number of pixels of indent for the icon at each tree level, wider indents are visually more pleasing,
         *  but will make the tree row header wider
         *  <br/>Defaults to 10
         */
        gridOptions.treeIndent = gridOptions.treeIndent || 10;

        /**
         *  @ngdoc object
         *  @name showTreeRowHeader
         *  @propertyOf  ui.grid.treeBase.api:GridOptions
         *  @description If set to false, don't create the row header.  Youll need to programatically control the expand
         *  states
         *  <br/>Defaults to true
         */
        gridOptions.showTreeRowHeader = gridOptions.showTreeRowHeader !== false;

        /**
         *  @ngdoc object
         *  @name showTreeExpandNoChildren
         *  @propertyOf  ui.grid.treeBase.api:GridOptions
         *  @description If set to true, show the expand/collapse button even if there are no
         *  children of a node.  You'd use this if you're planning to dynamically load the children
         * 
         *  <br/>Defaults to true, grouping overrides to false
         */
        gridOptions.showTreeExpandNoChildren = gridOptions.showTreeExpandNoChildren !== false;

        /**
         *  @ngdoc object
         *  @name treeRowHeaderAlwaysVisible
         *  @propertyOf  ui.grid.treeBase.api:GridOptions
         *  @description If set to true, row header even if there are no tree nodes
         * 
         *  <br/>Defaults to true
         */
        gridOptions.treeRowHeaderAlwaysVisible = gridOptions.treeRowHeaderAlwaysVisible !== false;
      },


      /**
       * @ngdoc function
       * @name treeBaseColumnBuilder
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Sets the tree defaults based on the columnDefs
       * 
       * @param {object} colDef columnDef we're basing on
       * @param {GridCol} col the column we're to update
       * @param {object} gridOptions the options we should use
       * @returns {promise} promise for the builder - actually we do it all inline so it's immediately resolved
       */
      treeBaseColumnBuilder: function (colDef, col, gridOptions) {

        /**
         *  @ngdoc object
         *  @name aggregation
         *  @propertyOf  ui.grid.treeBase.api:ColumnDef
         *  @description Calculate aggregations on this column.  Aggregations
         *  are an object in the format:
         * 
         *  <pre>
         *    {
         *      type: uiGridTreeBaseConstants.aggregation.SUM,
         *      label: <optional label, if provided we don't use the native i18n>
         *    }
         *  </pre>
         *
         *  If you are using aggregations you should either:
         * 
         *   - also use grouping, in which case the aggregations are displayed in the group header, OR
         *   - use treeView, in which case you can set `aggregationUpdateEntity: true` in the colDef, and
         *     treeBase will store the aggregation information in the entity, or you can set `aggregationUpdateEntity: false` 
         *     in the colDef, and you need to manual retrieve the calculated aggregations from the row.treeNode.aggregations
         * 
         *  <br/>Defaults to undefined.
         */
        if ( typeof(colDef.aggregation) !== 'undefined' ){
          col.aggregation = colDef.aggregation;
        }

        /**
         *  @ngdoc object
         *  @name aggregationUpdateEntity
         *  @propertyOf  ui.grid.treeBase.api:ColumnDef
         *  @description Store calculated aggregations into the entity, allowing them
         *  to be displayed in the grid using a standard cellTemplate.  This defaults to true,
         *  if you are using grouping then you shouldn't set it to false, as then the aggregations won't
         *  display.
         *
         *  If you are using treeView in most cases you'll want to set this to true.  This will result in 
         *  getCellValue returning the aggregation rather than whatever was stored in the cell attribute on
         *  the entity.  If you want to render the underlying entity value (and do something else with the aggregation)
         *  then you could use a custom cellTemplate to display `row.entity.myAttribute`, rather than using getCellValue.
         *
         *  <br/>Defaults to true
         * 
         *  @example
         *  <pre>
         *    gridOptions.columns = [{ 
         *      name: 'myCol', 
         *      aggregation: { type: 'sum' }, 
         *      aggregationUpdateEntity: true 
         *      cellTemplate: '<div>{{row.entity.myCol + " " + row.treeNode.aggregations[0].rendered}}</div>'
         *    }];
         * </pre>
         */
        col.aggregationUpdateEntity = colDef.aggregationUpdateEntity !== false;

        /**
         *  @ngdoc object
         *  @name customAggregationFinalizerFn
         *  @propertyOf  ui.grid.treeBase.api:ColumnDef
         *  @description A custom function that populates aggregation.rendered, this is called when
         *  a particular aggregation has been fully calculated, and we want to render the value.
         * 
         *  Typically we just concatenate aggregation.label and aggregation.value, but if you
         *  wanted to apply a filter or otherwise manipulate the label or the value, you can do
         *  so with this function.
         *
         *  @example
         *  <pre>
         *    customAggregationFinalizerFn = function ( aggregation ){
         *      aggregation.rendered = aggregation.label + aggregation.value / 100 + '%';
         *    }
         *  </pre>
         *  <br/>Defaults to undefined.
         */
        col.customAggregationFinalizerFn = colDef.customAggregationFinalizerFn;

        /**
         *  @ngdoc object
         *  @name customAggregationFn
         *  @propertyOf  ui.grid.treeBase.api:ColumnDef
         *  @description A custom function that aggregates rows into some form of
         *  total.  Aggregations run row-by-row, the function needs to be capable of
         *  creating a running total.
         *
         *  The function will be provided the aggregation item (in which you can store running
         *  totals), the row value that is to be aggregated, and that same row value converted to 
         *  a number (most aggregations work on numbers)
         *  @example
         *  <pre>
         *    customAggregationFn = function ( aggregation, fieldValue, numValue ){
         *      // calculates the average of the squares of the values
         *      if ( aggregation.count === undefined ){
         *        aggregation.count = 0;
         *      }
         *      aggregation.count++;
         * 
         *      if ( !isNaN(numValue) ){
         *        if ( aggregation.total === undefined ){
         *          aggregation.total = 0;
         *        }
         *        aggregation.total = aggregation.total + numValue * numValue;
         *      }
         *
         *      aggregation.value = aggregation.total / aggregation.count;
         *    }
         *  </pre>
         *  <br/>Defaults to undefined.  Required if you set the aggregation type to CUSTOM
         */
        col.customAggregationFn = colDef.customAggregationFn;
      },


      /**
       * @ngdoc function
       * @name createRowHeader
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Create the rowHeader.  If treeRowHeaderAlwaysVisible then
       * set it to visible, otherwise set it to invisible
       * 
       * @param {Grid} grid grid object
       */
      createRowHeader: function( grid ){
        var rowHeaderColumnDef = {
          name: uiGridTreeBaseConstants.rowHeaderColName,
          displayName: '',
          width:  grid.options.treeRowHeaderBaseWidth,
          minWidth: 10,
          cellTemplate: 'ui-grid/treeBaseRowHeader',
          headerCellTemplate: 'ui-grid/treeBaseHeaderCell',
          enableColumnResizing: false,
          enableColumnMenu: false,
          exporterSuppressExport: true,
          allowCellFocus: true
        };

        rowHeaderColumnDef.visible = grid.options.treeRowHeaderAlwaysVisible;
        grid.addRowHeaderColumn( rowHeaderColumnDef );
      },


      /**
       * @ngdoc function
       * @name expandAllRows
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Expands all nodes in the tree
       * 
       * @param {Grid} grid grid object
       */
      expandAllRows: function (grid) {
        grid.treeBase.tree.forEach( function( node ) {
          service.setAllNodes( grid, node, uiGridTreeBaseConstants.EXPANDED);
        });
        grid.treeBase.expandAll = true;
        grid.queueGridRefresh();
      },


      /**
       * @ngdoc function
       * @name collapseAllRows
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Collapses all nodes in the tree
       * 
       * @param {Grid} grid grid object
       */
      collapseAllRows: function (grid) {
        grid.treeBase.tree.forEach( function( node ) {
          service.setAllNodes( grid, node, uiGridTreeBaseConstants.COLLAPSED);
        });
        grid.treeBase.expandAll = false;
        grid.queueGridRefresh();
      },


      /**
       * @ngdoc function
       * @name setAllNodes
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Works through a subset of grid.treeBase.rowExpandedStates, setting
       * all child nodes (and their descendents) of the provided node to the given state.
       * 
       * Calls itself recursively on all nodes so as to achieve this.
       *
       * @param {Grid} grid the grid we're operating on (so we can raise events) 
       * @param {object} treeNode a node in the tree that we want to update
       * @param {string} targetState the state we want to set it to
       */
      setAllNodes: function (grid, treeNode, targetState) {
        if ( typeof(treeNode.state) !== 'undefined' && treeNode.state !== targetState ){
          treeNode.state = targetState;

          if ( targetState === uiGridTreeBaseConstants.EXPANDED ){
            grid.api.treeBase.raise.rowExpanded(treeNode.row);
          } else {
            grid.api.treeBase.raise.rowCollapsed(treeNode.row);
          }
        }

        // set all child nodes
        if ( treeNode.children ){
          treeNode.children.forEach(function( childNode ){
            service.setAllNodes(grid, childNode, targetState);
          });
        }
      },


      /**
       * @ngdoc function
       * @name toggleRowTreeState
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Toggles the expand or collapse state of this grouped row, if
       * it's a parent row
       * 
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to toggle
       */
      toggleRowTreeState: function ( grid, row ){
        if ( typeof(row.treeLevel) === 'undefined' || row.treeLevel === null || row.treeLevel < 0 ){
          return;
        }

        if (row.treeNode.state === uiGridTreeBaseConstants.EXPANDED){
          service.collapseRow(grid, row);
        } else {
          service.expandRow(grid, row);
        }

        grid.queueGridRefresh();
      },


      /**
       * @ngdoc function
       * @name expandRow
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Expands this specific row, showing only immediate children.
       * 
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to expand
       */
      expandRow: function ( grid, row ){
        if ( typeof(row.treeLevel) === 'undefined' || row.treeLevel === null || row.treeLevel < 0 ){
          return;
        }

        if ( row.treeNode.state !== uiGridTreeBaseConstants.EXPANDED ){
          row.treeNode.state = uiGridTreeBaseConstants.EXPANDED;
          grid.api.treeBase.raise.rowExpanded(row);
          grid.treeBase.expandAll = service.allExpanded(grid.treeBase.tree);
          grid.queueGridRefresh();
        }
      },


      /**
       * @ngdoc function
       * @name expandRowChildren
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Expands this specific row, showing all children.
       * 
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to expand
       */
      expandRowChildren: function ( grid, row ){
        if ( typeof(row.treeLevel) === 'undefined' || row.treeLevel === null || row.treeLevel < 0 ){
          return;
        }

        service.setAllNodes(grid, row.treeNode, uiGridTreeBaseConstants.EXPANDED);
        grid.treeBase.expandAll = service.allExpanded(grid.treeBase.tree);
        grid.queueGridRefresh();
      },


     /**
       * @ngdoc function
       * @name collapseRow
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Collapses this specific row
       *
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to collapse
       */
      collapseRow: function( grid, row ){
        if ( typeof(row.treeLevel) === 'undefined' || row.treeLevel === null || row.treeLevel < 0 ){
          return;
        }

        if ( row.treeNode.state !== uiGridTreeBaseConstants.COLLAPSED ){
          row.treeNode.state = uiGridTreeBaseConstants.COLLAPSED;
          grid.treeBase.expandAll = false;
          grid.api.treeBase.raise.rowCollapsed(row);
          grid.queueGridRefresh();
        }
      },


      /**
       * @ngdoc function
       * @name collapseRowChildren
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Collapses this specific row and all children
       *
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to collapse
       */
      collapseRowChildren: function( grid, row ){
        if ( typeof(row.treeLevel) === 'undefined' || row.treeLevel === null || row.treeLevel < 0 ){
          return;
        }

        service.setAllNodes(grid, row.treeNode, uiGridTreeBaseConstants.COLLAPSED);
        grid.treeBase.expandAll = false;
        grid.queueGridRefresh();
      },


      /**
       * @ngdoc function
       * @name allExpanded
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Returns true if all rows are expanded, false
       * if they're not.  Walks the tree to determine this.  Used
       * to set the expandAll state.
       * 
       * If the node has no children, then return true (it's immaterial
       * whether it is expanded).  If the node has children, then return
       * false if this node is collapsed, or if any child node is not all expanded
       *
       * @param {object} tree the grid to check
       * @returns {boolean} whether or not the tree is all expanded
       */
      allExpanded: function( tree ){
        var allExpanded = true;
        tree.forEach( function( node ){
          if ( !service.allExpandedInternal( node ) ){
            allExpanded = false;
          }
        });
        return allExpanded;
      },

      allExpandedInternal: function( treeNode ){
        if ( treeNode.children && treeNode.children.length > 0 ){
          if ( treeNode.state === uiGridTreeBaseConstants.COLLAPSED ){
            return false;
          }
          var allExpanded = true;
          treeNode.children.forEach( function( node ){
            if ( !service.allExpandedInternal( node ) ){
              allExpanded = false;
            }
          });
          return allExpanded;
        } else {
          return true;
        }
      },


      /**
       * @ngdoc function
       * @name treeRows
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description The rowProcessor that adds the nodes to the tree, and sets the visible
       * state of each row based on it's parent state
       * 
       * Assumes it is always called after the sorting processor, and the grouping processor if there is one.
       * Performs any tree sorts itself after having built the tree
       * 
       * Processes all the rows in order, setting the group level based on the $$treeLevel in the associated
       * entity, and setting the visible state based on the parent's state.
       * 
       * Calculates the deepest level of tree whilst it goes, and updates that so that the header column can be correctly 
       * sized.
       * 
       * Aggregates if necessary along the way.
       * 
       * @param {array} renderableRows the rows we want to process, usually the output from the previous rowProcessor
       * @returns {array} the updated rows
       */
      treeRows: function( renderableRows ) {
        if (renderableRows.length === 0){
          return renderableRows;
        }

        var grid = this;
        var currentLevel = 0;
        var currentState = uiGridTreeBaseConstants.EXPANDED;
        var parents = [];

        grid.treeBase.tree = service.createTree( grid, renderableRows );
        service.updateRowHeaderWidth( grid );

        service.sortTree( grid );
        service.fixFilter( grid );

        return service.renderTree( grid.treeBase.tree );
      },


      /**
       * @ngdoc function
       * @name createOrUpdateRowHeaderWidth
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Calculates the rowHeader width.
       * 
       * If rowHeader is always present, updates the width.
       * 
       * If rowHeader is only sometimes present (`treeRowHeaderAlwaysVisible: false`), determines whether there 
       * should be one, then creates or removes it as appropriate, with the created rowHeader having the 
       * right width.
       * 
       * If there's never a rowHeader then never creates one: `showTreeRowHeader: false`
       * 
       * @param {Grid} grid the grid we want to set the row header on
       */
      updateRowHeaderWidth: function( grid ){
        var rowHeader = grid.getColumn(uiGridTreeBaseConstants.rowHeaderColName);

        var newWidth = grid.options.treeRowHeaderBaseWidth + grid.options.treeIndent * grid.treeBase.numberLevels;
        if ( rowHeader && newWidth !== rowHeader.width ){
          rowHeader.width = newWidth;
          grid.queueRefresh();
        }

        var newVisibility = true;
        if ( grid.options.showTreeRowHeader === false ){
          newVisibility = false;
        }
        if ( grid.options.treeRowHeaderAlwaysVisible === false && grid.treeBase.numberLevels <= 0 ){
          newVisibility = false;
        }
        if ( rowHeader.visible !== newVisibility ) {
          rowHeader.visible = newVisibility;
          grid.queueRefresh();
        }
      },


      /**
       * @ngdoc function
       * @name renderTree
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Creates an array of rows based on the tree, exporting only
       * the visible nodes and leaves
       *
       * @param {array} nodeList the list of nodes - can be grid.treeBase.tree, or can be node.children when
       * we're calling recursively
       * @returns {array} renderable rows
       */
      renderTree: function( nodeList ){
        var renderableRows = [];

        nodeList.forEach( function ( node ){
          if ( node.row.visible ){
            renderableRows.push( node.row );
          }
          if ( node.state === uiGridTreeBaseConstants.EXPANDED && node.children && node.children.length > 0 ){
            renderableRows = renderableRows.concat( service.renderTree( node.children ) );
          }
        });
        return renderableRows;
      },


      /**
       * @ngdoc function
       * @name createTree
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Creates a tree from the renderableRows
       * 
       * @param {Grid} grid the grid
       * @param {array} renderableRows the rows we want to create a tree from
       * @returns {object} the tree we've build
       */
      createTree: function( grid, renderableRows ) {
        var currentLevel = -1;
        var parents = [];
        var currentState;
        grid.treeBase.tree = [];
        var aggregations = service.getAggregations( grid );

        var createNode = function( row ){
          row.treeLevel = row.entity.$$treeLevel;

          if ( row.treeLevel <= currentLevel ){
            // pop any levels that aren't parents of this level, formatting the aggregation at the same time
            while ( row.treeLevel <= currentLevel ){
              var lastParent = parents.pop();
              service.finaliseAggregations( lastParent );
              currentLevel--;
            }

            // reset our current state based on the new parent, set to expanded if this is a level 0 node
            if ( parents.length > 0 ){
              currentState = service.setCurrentState(parents);
            } else {
              currentState = uiGridTreeBaseConstants.EXPANDED;
            }
          }

          // aggregate if this is a leaf node
          if ( row.treeLevel === undefined || row.treeLevel === null || row.treeLevel < 0  ){
            service.aggregate( grid, row, parents );
          }

          // add this node to the tree
          service.addOrUseNode(grid, row, parents, aggregations);

          if (row.treeLevel !== undefined && row.treeLevel !== null && row.treeLevel >= 0 ){
            parents.push(row);
            currentLevel++;
            currentState = service.setCurrentState(parents);
          }

          // update the tree number of levels, so we can set header width if we need to
          if ( grid.treeBase.numberLevels < row.treeLevel ){
            grid.treeBase.numberLevels = row.treeLevel;
          }
        };

        renderableRows.forEach( createNode );

        // finalise remaining aggregations
        while ( parents.length > 0 ){
          var lastParent = parents.pop();
          service.finaliseAggregations( lastParent );
        }

        return grid.treeBase.tree;
      },


      /**
       * @ngdoc function
       * @name addOrUseNode
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Creates a tree node for this row.  If this row already has a treeNode
       * recorded against it, preserves the state, but otherwise overwrites the data.
       * 
       * @param {grid} grid the grid we're operating on
       * @param {gridRow} row the row we want to set
       * @param {array} parents an array of the parents this row should have
       * @param {array} aggregationBase empty aggregation information
       * @returns {undefined} updates the parents array, updates the row to have a treeNode, and updates the
       * grid.treeBase.tree
       */
      addOrUseNode: function( grid, row, parents, aggregationBase ){
        var newAggregations = [];
        aggregationBase.forEach( function(aggregation){
          newAggregations.push({ col: aggregation.col, type: aggregation.type, label: aggregation.label });
        });

        var newNode = { state: uiGridTreeBaseConstants.COLLAPSED, row: row, parentRow: null, aggregations: newAggregations, children: [] };
        if ( row.treeNode ){
          newNode.state = row.treeNode.state;
        }
        if ( parents.length > 0 ){
          newNode.parentRow = parents[parents.length - 1];
        }
        row.treeNode = newNode;

        if ( parents.length === 0 ){
          grid.treeBase.tree.push( newNode );
        } else {
          parents[parents.length - 1].treeNode.children.push( newNode ); 
        }
      },


      /**
       * @ngdoc function
       * @name setCurrentState
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Looks at the parents array to determine our current state.
       * If any node in the hierarchy is collapsed, then return collapsed, otherwise return
       * expanded.
       * 
       * @param {array} parents an array of the parents this row should have
       * @returns {string} the state we should be setting to any nodes we see
       */
      setCurrentState: function( parents ){
        var currentState = uiGridTreeBaseConstants.EXPANDED;
        parents.forEach( function(parent){
          if ( parent.treeNode.state === uiGridTreeBaseConstants.COLLAPSED ){
            currentState = uiGridTreeBaseConstants.COLLAPSED;
          }
        });
        return currentState;
      },


      /**
       * @ngdoc function
       * @name sortTree
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Performs a recursive sort on the tree nodes, sorting the 
       * children of each node and putting them back into the children array.
       * 
       * Before doing this it turns back on all the sortIgnore - things that were previously
       * ignored we process now.  Since we're sorting within the nodes, presumably anything 
       * that was already sorted is how we derived the nodes, we can keep those sorts too.
       * 
       * We only sort tree nodes that are expanded - no point in wasting effort sorting collapsed
       * nodes
       * 
       * @param {Grid} grid the grid to get the aggregation information from
       * @returns {array} the aggregation information
       */
      sortTree: function( grid ){
        grid.columns.forEach( function( column ) {
          if ( column.sort && column.sort.ignoreSort ){
            delete column.sort.ignoreSort;
          }
        });

        grid.treeBase.tree = service.sortInternal( grid, grid.treeBase.tree );
      },

      sortInternal: function( grid, treeList ){
        var rows = treeList.map( function( node ){
          return node.row;
        });

        rows = rowSorter.sort( grid, rows, grid.columns );

        var treeNodes = rows.map( function( row ){
          return row.treeNode;
        });

        treeNodes.forEach( function( node ){
          if ( node.state === uiGridTreeBaseConstants.EXPANDED && node.children && node.children.length > 0 ){
            node.children = service.sortInternal( grid, node.children );
          }
        });

        return treeNodes;
      },

      /**
       * @ngdoc function
       * @name fixFilter
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description After filtering has run, we need to go back through the tree
       * and make sure the parent rows are always visible if any of the child rows
       * are visible (filtering may make a child visible, but the parent may not 
       * match the filter criteria)
       * 
       * This has a risk of being computationally expensive, we do it by walking
       * the tree and remembering whether there are any invisible nodes on the 
       * way down.
       * 
       * @param {Grid} grid the grid to fix filters on
       */
      fixFilter: function( grid ){
        var parentsVisible;

        grid.treeBase.tree.forEach( function( node ){
          if ( node.children && node.children.length > 0 ){
            parentsVisible = node.row.visible;
            service.fixFilterInternal( node.children, parentsVisible );
          }
        });
      },

      fixFilterInternal: function( nodes, parentsVisible) {
        nodes.forEach( function( node ){
          if ( node.row.visible && !parentsVisible ){
            service.setParentsVisible( node );
            parentsVisible = true;
          }

          if ( node.children && node.children.length > 0 ){
            if ( service.fixFilterInternal( node.children, ( parentsVisible && node.row.visible ) ) ) {
              parentsVisible = true;
            }
          }
        });

        return parentsVisible;
      },

      setParentsVisible: function( node ){
        while ( node.parentRow ){
          node.parentRow.visible = true;
          node = node.parentRow.treeNode;
        }
      },

      /**
       * @ngdoc function
       * @name getAggregations
       * @methodOf  ui.grid.treeBase.service:uiGridTreeBaseService
       * @description Looks through the grid columns to find those with aggregations,
       * and collates the aggregation information into an array, returns that array
       * 
       * @param {Grid} grid the grid to get the aggregation information from
       * @returns {array} the aggregation information
       */
      getAggregations: function( grid ){
        var aggregateArray = [];

        grid.columns.forEach( function(column){
          if ( column.aggregation ){
            var newAggregation = { col: column, type: column.aggregation.type, value: 0, label: column.aggregation.label };
            if ( !newAggregation.label ){
              newAggregation.label = i18nService.get().aggregation[newAggregation.type];
            }
            aggregateArray.push( newAggregation );
          }
        });
        return aggregateArray;
      },


     /**
       * @ngdoc function
       * @name aggregate
       * @methodOf  ui.grid.grouping.service:uiGridGroupingService
       * @description Accumulate the data from this row onto the aggregations for each parent
       * 
       * Iterate over the parents, then iterate over the aggregations for each of those parents,
       * and perform the aggregation for each individual aggregation
       * 
       * @param {Grid} grid grid object
       * @param {GridRow} row the row we want to set grouping visibility on
       * @param {array} parents the parents that we would want to aggregate onto
       */
      aggregate: function( grid, row, parents ){
        if ( parents.length === 0 ){
          return;
        }

        parents.forEach( function( parent ){
          if ( parent.treeNode.aggregations ){
            parent.treeNode.aggregations.forEach( function( aggregation ){
              var fieldValue = grid.getCellValue(row, aggregation.col);
              var numValue = Number(fieldValue);
              switch (aggregation.type) {
                case uiGridTreeBaseConstants.aggregation.COUNT:
                  service.aggregateCount( aggregation, fieldValue, numValue );
                  break;
                case uiGridTreeBaseConstants.aggregation.SUM:
                  service.aggregateSum( aggregation, fieldValue, numValue );
                  break;
                case uiGridTreeBaseConstants.aggregation.MIN:
                  service.aggregateMin( aggregation, fieldValue, numValue );
                  break;
                case uiGridTreeBaseConstants.aggregation.MAX:
                  service.aggregateMax( aggregation, fieldValue, numValue );
                  break;
                case uiGridTreeBaseConstants.aggregation.AVG:
                  service.aggregateAvg( aggregation, fieldValue, numValue );
                  break;
                case uiGridTreeBaseConstants.aggregation.CUSTOM:
                  service.aggregateCustom( aggregation, fieldValue, numValue );
                  break;
              }
            });
          }
        });
      },

      // Aggregation routines - no doco needed as self evident
      aggregateCount: function( aggregation, fieldValue, numValue ){
        if ( aggregation.value === undefined ){
          aggregation.value = 1;
        } else {
          aggregation.value++;
        }
      },

      aggregateSum: function( aggregation, fieldValue, numValue ){
        if (!isNaN(numValue)){
          if ( aggregation.value === undefined ){
            aggregation.value = numValue;
          } else {
            aggregation.value += numValue;
          }
        }
      },

      aggregateMin: function( aggregation, fieldValue, numValue ){
        if ( aggregation.value === undefined ){
          aggregation.value = fieldValue;
        } else {
          if (fieldValue !== undefined && fieldValue !== null && (fieldValue < aggregation.value || aggregation.value === null)){
            aggregation.value = fieldValue;
          }
        }
      },

      aggregateMax: function( aggregation, fieldValue, numValue ){
        if ( aggregation.value === undefined ){
          aggregation.value = fieldValue;
        } else {
          if (fieldValue !== undefined && fieldValue !== null && (fieldValue > aggregation.value || aggregation.value === null)){
            aggregation.value = fieldValue;
          }
        }
      },

      aggregateAvg: function( aggregation, fieldValue, numValue ){
        if ( aggregation.count === undefined ){
          aggregation.count = 1;
        } else {
          aggregation.count++;
        }

        if ( isNaN(numValue) ){
          return;
        }

        if ( aggregation.value === undefined || aggregation.sum === undefined ){
          aggregation.value = numValue;
          aggregation.sum = numValue;
        } else {
          aggregation.sum += numValue;
          aggregation.value = aggregation.sum / aggregation.count;
        }
      },

      aggregateCustom: function( aggregation, fieldValue, numValue ){
        if ( typeof(aggregation.col.customAggregationFn) !== 'function' ) {
          gridUtil.logError( 'If you set aggregation type to custom, you need to provide a customAggregationFn on the colDef' );
          return;
        }

        aggregation.col.customAggregationFn( aggregation, fieldValue, numValue );
      },


      /**
       * @ngdoc function
       * @name finaliseAggregations
       * @methodOf  ui.grid.grouping.service:uiGridGroupingService
       * @description Format the data from the aggregation into the rendered text
       * e.g. if we had label: 'sum: ' and value: 25, we'd create 'sum: 25'.
       *
       * As part of this we call any formatting callback routines we've been provided.
       * 
       * @param {gridRow} row the parent we're finalising
       */
      finaliseAggregations: function( row ){
        if ( typeof(row.treeNode.aggregations) === 'undefined' ){
          return;
        }

        row.treeNode.aggregations.forEach( function( aggregation ) {
          if ( typeof(aggregation.col.customAggregationFinalizerFn) === 'function' ){
            aggregation.col.customAggregationFinalizerFn( aggregation );
          } else {
            aggregation.rendered = aggregation.label + aggregation.value;
          }

          if ( aggregation.col.aggregationUpdateEntity ){
            var aggregationCopy = {};
            angular.forEach( aggregation, function( value, key ){
              if ( aggregation.hasOwnProperty(key) && key !== 'col' ){
                aggregationCopy[key] = value;
              }
            });
            row.entity[ '$$' + aggregation.col.uid ] = aggregationCopy;
          }
        });
      }
    };

    return service;

  }]);


  /**
   *  @ngdoc directive
   *  @name ui.grid.treeBase.directive:uiGridTreeRowHeaderButtons
   *  @element div
   *
   *  @description Provides the expand/collapse button on rows
   */
  module.directive('uiGridTreeBaseRowHeaderButtons', ['$templateCache', 'uiGridTreeBaseService',
  function ($templateCache, uiGridTreeBaseService) {
    return {
      replace: true,
      restrict: 'E',
      template: $templateCache.get('ui-grid/treeBaseRowHeaderButtons'),
      scope: true,
      require: '^uiGrid',
      link: function($scope, $elm, $attrs, uiGridCtrl) {
        var self = uiGridCtrl.grid;
        $scope.treeButtonClick = function(row, evt) {
          uiGridTreeBaseService.toggleRowTreeState(self, row, evt);
        };
      }
    };
  }]);


  /**
   *  @ngdoc directive
   *  @name ui.grid.treeBase.directive:uiGridTreeBaseExpandAllButtons
   *  @element div
   *
   *  @description Provides the expand/collapse all button 
   */
  module.directive('uiGridTreeBaseExpandAllButtons', ['$templateCache', 'uiGridTreeBaseService',
  function ($templateCache, uiGridTreeBaseService) {
    return {
      replace: true,
      restrict: 'E',
      template: $templateCache.get('ui-grid/treeBaseExpandAllButtons'),
      scope: false,
      link: function($scope, $elm, $attrs, uiGridCtrl) {
        var self = $scope.col.grid;

        $scope.headerButtonClick = function(row, evt) {
          if ( self.treeBase.expandAll ){
            uiGridTreeBaseService.collapseAllRows(self, evt);
          } else {
            uiGridTreeBaseService.expandAllRows(self, evt);
          }
        };
      }
    };
  }]);
})();
